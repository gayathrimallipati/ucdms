const { expect } = require('@playwright/test');
const {
  dismissAppModals,
  selectIfVisible,
  selectSearchOption,
  selectWrapper,
  fillIfVisible,
  isVisible,
} = require('./form');
const { toast } = require('./login');
const {
  uploadMandatoryImages,
  skipImagesOnLocalDms,
  expandEvaluationSections,
  ensureRowVisible,
  logSectionProgress,
  fillRandomRefurbCost,
  isEvaluationCompleted,
  dismissLatestEvalModal,
} = require('./pm-evaluation');

const PICKER_ID = 'dms-stock-picker';
const MAX_CERTIFICATION_AGE_YEARS = 5;
const MAX_CERTIFICATION_MILEAGE_KM = 125000;
const INVENTORY_STATUS = {
  REFURBISHMENT_PENDING: 1,
  CERTIFICATION_IN_PROGRESS: 2,
  READY_FOR_SALE: 3,
};
const SKIPPED_SECTION_LABELS = ['Demo Section'];
const DEFAULT_LISTING_PRICE = 249000;

function parseMoney(value) {
  const amount = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) ? amount : 0;
}

function replacementListingPrice(indicative) {
  const fromEnv = Number(process.env.DMS_STOCK_LISTING_PRICE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.round(fromEnv);
  const fromIndicative = parseMoney(indicative);
  if (fromIndicative > 0) return Math.round(fromIndicative);
  return DEFAULT_LISTING_PRICE + Math.floor(Math.random() * 151) * 1000;
}

function pickTimeoutMs() {
  const value = Number(process.env.DMS_STOCK_PICK_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
}

function normalizeStockId(raw) {
  const value = String(raw || '').trim();
  const digits = value.replace(/^INV/i, '').replace(/\D/g, '');
  return {
    formatted: digits ? `INV${digits}` : value.toUpperCase(),
    digits,
  };
}

async function collectVisibleStocks(page) {
  return page.evaluate(() => {
    const stocks = [];
    const seen = new Set();
    document.querySelectorAll('table tbody tr, .mobilecard').forEach((row) => {
      const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
      const match = text.match(/(?:Stock\s*ID|ID)\s*:?\s*(INV\d+)/i)
        || text.match(/\b(INV\d+)\b/i);
      if (!match) return;
      const id = match[1].toUpperCase();
      if (seen.has(id)) return;
      seen.add(id);
      stocks.push({ id, summary: text.slice(0, 180) });
    });
    return stocks;
  });
}

async function removeStockPicker(page) {
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
    delete window.__dmsStockChoice;
    try {
      sessionStorage.removeItem('__dmsStockChoice');
    } catch {
      /* sessionStorage unavailable */
    }
  }, PICKER_ID).catch(() => {});
}

async function showStockPicker(page, stocks) {
  await page.evaluate(({ pickerId, items }) => {
    document.getElementById(pickerId)?.remove();
    window.__dmsStockChoice = null;
    const root = document.createElement('div');
    root.id = pickerId;
    root.innerHTML = `
      <style>
        #${pickerId} { position:fixed; top:16px; right:16px; width:360px; max-height:calc(100vh - 32px);
          z-index:2147483647; background:#111827; color:#f9fafb; border:1px solid #374151;
          border-radius:8px; font:13px/1.4 Segoe UI,system-ui,sans-serif; overflow:auto; }
        #${pickerId} * { box-sizing:border-box; }
        #${pickerId} .hd { padding:12px 14px 8px; border-bottom:1px solid #374151; }
        #${pickerId} h2 { margin:0 0 4px; font-size:15px; font-weight:650; }
        #${pickerId} .sub,#${pickerId} .count { color:#9ca3af; font-size:12px; }
        #${pickerId} .bd { padding:12px 14px 14px; }
        #${pickerId} label { display:block; margin-bottom:6px; color:#d1d5db; }
        #${pickerId} .row { display:flex; gap:8px; }
        #${pickerId} input { flex:1; min-width:0; padding:8px 10px; border:1px solid #4b5563;
          border-radius:6px; background:#1f2937; color:#f9fafb; }
        #${pickerId} button { border:0; border-radius:6px; padding:8px 12px; cursor:pointer; font-weight:600; }
        #${pickerId} .go { background:#2563eb; color:#fff; }
        #${pickerId} .ghost { background:#374151; color:#e5e7eb; }
        #${pickerId} .list { display:flex; flex-direction:column; gap:6px; max-height:340px; overflow:auto; }
        #${pickerId} .stock { text-align:left; width:100%; background:#1f2937; color:#f9fafb;
          border:1px solid #374151; }
        #${pickerId} .stock:hover { background:#1e3a5f; }
        #${pickerId} .stock b { display:block; }
        #${pickerId} .stock span { display:block; color:#9ca3af; font-size:11px; font-weight:400;
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        #${pickerId} .err { color:#fca5a5; min-height:16px; margin:6px 0 10px; font-size:12px; }
        #${pickerId} .actions { display:flex; gap:8px; margin-top:12px; }
      </style>
      <div class="hd">
        <h2>Choose a stock to work on</h2>
        <div class="sub">Type a Stock ID or click one from the list. No row is opened unless you pick it.</div>
      </div>
      <div class="bd">
        <label for="${pickerId}-input">Stock ID (example: INV1)</label>
        <div class="row">
          <input id="${pickerId}-input" type="text" placeholder="INV1" autocomplete="off" />
          <button type="button" class="go" data-act="typed">Continue</button>
        </div>
        <div class="err"></div>
        <div class="count">${items.length
          ? `${items.length} stock(s) on this page`
          : 'No stock on this page. Search the grid, then Refresh list.'}</div>
        <div class="list"></div>
        <div class="actions">
          <button type="button" class="ghost" data-act="refresh">Refresh list from grid</button>
          <button type="button" class="ghost" data-act="cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    const input = root.querySelector('input');
    const error = root.querySelector('.err');

    // Persist to sessionStorage as well: the SPA re-renders while the panel is
    // open, and a lost window variable would silently drop the click.
    const setChoice = (value) => {
      window.__dmsStockChoice = value;
      try {
        sessionStorage.setItem('__dmsStockChoice', JSON.stringify(value));
      } catch {
        /* sessionStorage unavailable */
      }
    };
    const choose = (raw) => {
      const id = String(raw || '').trim();
      if (!id) {
        error.textContent = 'Enter or click a Stock ID first.';
        input.focus();
        return;
      }
      setChoice({ action: 'pick', id });
    };

    // Delegate from the panel root so the list keeps working after a re-render.
    root.addEventListener('click', (event) => {
      const target = event.target.closest('[data-act]');
      if (!target) return;
      event.preventDefault();
      const action = target.getAttribute('data-act');
      if (action === 'pick') choose(target.getAttribute('data-id'));
      else if (action === 'typed') choose(input.value);
      else if (action === 'refresh') setChoice({ action: 'refresh' });
      else if (action === 'cancel') setChoice({ action: 'cancel' });
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        choose(input.value);
      }
    });

    const list = root.querySelector('.list');
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'stock';
      button.dataset.act = 'pick';
      button.dataset.id = item.id;
      const id = document.createElement('b');
      id.textContent = item.id;
      const summary = document.createElement('span');
      summary.textContent = item.summary || '';
      button.append(id, summary);
      list.appendChild(button);
    });
    input.focus();
  }, { pickerId: PICKER_ID, items: stocks });
}

async function readStockChoice(page) {
  return page.evaluate(() => {
    let choice = window.__dmsStockChoice || null;
    if (!choice) {
      try {
        const stored = sessionStorage.getItem('__dmsStockChoice');
        if (stored) choice = JSON.parse(stored);
      } catch {
        choice = null;
      }
    }
    window.__dmsStockChoice = null;
    try {
      sessionStorage.removeItem('__dmsStockChoice');
    } catch {
      /* sessionStorage unavailable */
    }
    return choice;
  }).catch(() => null);
}

async function waitForStockChoice(page, deadline) {
  while (Date.now() < deadline) {
    const choice = await readStockChoice(page);
    if (choice) return choice;
    const alive = await page.locator(`#${PICKER_ID}`).count().catch(() => 0);
    if (!alive) {
      await showStockPicker(page, await collectVisibleStocks(page));
      console.log('  Picker was removed by the page — re-opened it.');
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function chooseStockFromBrowser(page) {
  const timeout = pickTimeoutMs();
  const deadline = Date.now() + timeout;
  console.log('\n[stock] Pick the stock in the Chrome panel on the right.');
  console.log('[stock] You can search the My Stock grid, then click Refresh list.');
  console.log(`[stock] Waiting up to ${Math.round(timeout / 1000)}s for your choice…`);

  while (Date.now() < deadline) {
    const stocks = await collectVisibleStocks(page);
    if (stocks.length) {
      console.log(`  Stock currently on the grid: ${stocks.map((item) => item.id).join(', ')}`);
    } else {
      console.log('  No stock on the current grid page. Use Search, then Refresh list.');
    }

    await showStockPicker(page, stocks);
    const choice = await waitForStockChoice(page, deadline);

    if (!choice) break;
    if (choice.action === 'cancel') {
      await removeStockPicker(page);
      throw new Error('Stock run cancelled. No stock was opened.');
    }
    if (choice.action === 'refresh') {
      console.log('  Refreshing list from the grid…');
      await page.waitForLoadState('networkidle').catch(() => {});
      continue;
    }

    const stock = normalizeStockId(choice.id);
    if (!stock.digits) {
      console.log('  That is not a Stock ID. Try again (example: INV1).');
      continue;
    }
    await removeStockPicker(page);
    console.log(`  You chose Stock ID ${stock.formatted}`);
    return stock;
  }

  await removeStockPicker(page);
  throw new Error('Timed out waiting for a stock to be chosen in the browser.');
}

async function applyGridSearch(page, stockId) {
  const search = page.locator('#search').first();
  await expect(search).toBeVisible({ timeout: 20000 });
  await search.click();
  await search.fill(stockId);
  await search.press('Tab');
  // Scope to the filter panel like the edit flow does: an unscoped lookup
  // resolves to the advanced-filter modal's hidden Search button and hangs.
  await page.locator('.search-filter').getByRole('button', { name: /^Search$/i }).first().click();
  await page.locator('.skeleton').first().waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
  await page.getByText(/Showing \d+/i).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
}

const ROW_MARK = 'data-dms-stock-row';

/**
 * Find the row in the DOM with the same scan that lists the picker suggestions,
 * then tag it so the click target cannot drift to another row. A Playwright
 * text filter disagreed with the picker list on rows that are plainly there.
 */
async function markStockRow(page, id) {
  return page.evaluate(({ stockId, attr }) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
    const pattern = new RegExp(`\\b${stockId}\\b`, 'i');
    const rows = Array.from(document.querySelectorAll('table tbody tr, .mobilecard'));
    const texts = rows.map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim());
    const index = texts.findIndex((text) => pattern.test(text));
    if (index < 0) return { found: false, texts };

    const row = rows[index];
    row.setAttribute(attr, stockId);
    const href = Array.from(row.querySelectorAll('a[href]'))
      .map((link) => link.getAttribute('href') || '')
      .find((value) => /\/detail\//i.test(value)) || '';
    return { found: true, href, text: texts[index].slice(0, 160) };
  }, { stockId: id, attr: ROW_MARK });
}

/**
 * View renders as an icon plus a label (common_grid.js line 1343), so the
 * accessible name is not exactly "View". Match it loosely, and fall back to the
 * row's own detail href, which the grid always sets.
 */
async function openMarkedRow(page, formatted, href) {
  const row = page.locator(`[${ROW_MARK}]`).first();
  const view = row.getByRole('link', { name: /View/i })
    .or(row.locator('a[title="View"], a[aria-label="View"]'))
    .or(row.locator('a[href*="/detail/"]'))
    .first();

  if (await view.isVisible().catch(() => false)) {
    await view.click({ timeout: 10000 }).catch(() => {});
    const opened = await page.waitForURL(/\/my-stock\/detail\/[^/]+/, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }

  if (href) {
    console.log(`  View click did not navigate — opening ${formatted} via ${href}`);
    await page.goto(href, { waitUntil: 'networkidle' });
    await expect(page).toHaveURL(/\/my-stock\/detail\/[^/]+/, { timeout: 20000 });
    return;
  }
  throw new Error(`Could not open ${formatted}: its row has no detail link.`);
}

async function openChosenStock(page, stock) {
  let row = await markStockRow(page, stock.formatted);
  if (!row.found) {
    console.log(`  ${stock.formatted} is not on this grid page — searching for it.`);
    await applyGridSearch(page, stock.formatted);
    for (let attempt = 0; attempt < 10 && !row.found; attempt++) {
      await page.waitForTimeout(500);
      row = await markStockRow(page, stock.formatted);
    }
  }
  if (!row.found) {
    const seen = (row.texts || []).map((text) => `    ${text.slice(0, 120)}`).join('\n');
    console.log(`  Grid rows after search:\n${seen || '    (none)'}`);
    throw new Error(`Stock ${stock.formatted} is not on the grid. No row was opened.`);
  }

  console.log(`  Matched row: ${row.text}`);
  await openMarkedRow(page, stock.formatted, row.href);
  console.log(`[stock] Opened ${stock.formatted} only → ${page.url()}`);
}

async function openStockTab(page, label) {
  const tab = page.getByText(new RegExp(`^${label}$`, 'i')).first();
  await expect(tab).toBeVisible({ timeout: 20000 });
  await tab.click();
  await page.waitForTimeout(500);
}

/**
 * Stage labels the footer action Submit or Confirm. Scoping to form.last()
 * often matches a hidden button in another mounted form, so isVisible is
 * false and the click is skipped. Use the first visible page-level button.
 */
async function visibleActionButton(page, names = /^(Submit|Confirm)$/i) {
  const buttons = page.getByRole('button', { name: names });
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    if (await button.isVisible().catch(() => false)) return button;
  }
  return page.locator('form button.btn-dark, button.btn-dark').filter({
    hasText: names,
  }).first();
}

async function acceptConfirmToast(page, timeout = 8000) {
  const dialog = page.locator('.card.shadow-sm').filter({
    hasText: /Are you sure you want to proceed/i,
  });
  const yes = dialog.locator('button.btn-ok').filter({
    hasText: /^(Yes|Confirm|OK)$/i,
  }).or(page.locator('button.btn-ok').filter({ hasText: /^(Yes|Confirm|OK)$/i }));
  try {
    await yes.first().waitFor({ state: 'visible', timeout });
    await yes.first().click({ force: true });
    console.log('[stock] Clicked Yes on the Confirm dialog.');
    await dialog.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function clickAndSave(page, { names, responseTest, timeout = 25000, expectConfirm = false } = {}) {
  const button = await visibleActionButton(page, names);
  await expect(button).toBeVisible({ timeout: 15000 });
  await button.scrollIntoViewIfNeeded().catch(() => {});
  const responsePromise = page.waitForResponse(async (response) => {
    if (response.request().method() !== 'POST') return false;
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    let post = '';
    try {
      post = response.request().postData() || '';
    } catch {
      post = '';
    }
    return responseTest(body, post);
  }, { timeout }).catch(() => null);

  await button.click({ timeout: 8000 }).catch(async () => {
    await button.evaluate((el) => el.click());
  });
  await acceptConfirmToast(page, expectConfirm ? 10000 : 800);
  return responsePromise;
}

async function updateSelectsThatAreEnabled(page) {
  const wrappers = page.locator('form .selectsearch-wrapper');
  const count = await wrappers.count();
  const changed = [];
  for (let i = 0; i < count; i++) {
    const wrapper = wrappers.nth(i);
    if (!(await wrapper.isVisible().catch(() => false))) continue;
    const id = await wrapper.getAttribute('id');
    if (!id) continue;
    const disabled = await wrapper.evaluate((node) =>
      node.classList.contains('opacity-50')
      || node.getAttribute('aria-disabled') === 'true'
    ).catch(() => true);
    if (disabled) continue;
    const selected = await selectIfVisible(page, id);
    if (selected) changed.push(id);
  }
  return changed;
}

async function updateEnabledStockDetails(page) {
  await openStockTab(page, 'STOCK DETAIL');
  await expect(page.locator('form')).toBeVisible({ timeout: 20000 });
  const changed = await updateSelectsThatAreEnabled(page);

  const desiredMileage = Math.min(
    Number(process.env.DMS_STOCK_MILEAGE) || 50000,
    MAX_CERTIFICATION_MILEAGE_KM - 1
  );
  if (await fillIfVisible(page, 'mileage', String(desiredMileage))) changed.push('mileage');

  const listing = await ensureListingPrice(page, { alreadyOnDetails: true, submit: false });
  if (listing.updated) changed.push('listing_price');

  const stamp = Date.now().toString().slice(-6);
  if (await fillIfVisible(page, 'remarks', `Stock details updated by automation ${stamp}`)) {
    changed.push('remarks');
  }

  const submit = await visibleActionButton(page, /^(Submit|Confirm)$/i);
  if (!(await submit.isVisible().catch(() => false))) {
    console.log('[stock] Stock details are read-only for this user; nothing submitted.');
    if (parseMoney(listing.listingPrice) <= 0 && listing.updated) {
      throw new Error('Listing price is 0 and Stock Details cannot be submitted, so Ready For Sale would be refused.');
    }
    return { submitted: false, changed, listingPrice: listing.listingPrice };
  }

  const response = await clickAndSave(page, {
    names: /^(Submit|Confirm)$/i,
    responseTest: (body, post) => /stock details (updated|not updated)/i.test(body?.msg || '')
      || /updatelead/i.test(post || ''),
  });
  const body = response ? await response.json().catch(() => ({})) : {};
  if (!response || response.status() !== 200 || body.status !== 'ok') {
    const error = await page.locator('.invalid-feedback, .alert-danger').first().textContent().catch(() => '');
    throw new Error(`Stock details update failed. ${body.msg || error || 'No successful API response.'}`);
  }
  console.log(`[stock] Updated enabled fields: ${changed.join(', ') || '(none)'}.`);
  const confirmed = await confirmListingPrice(page);
  return { submitted: true, changed, listingPrice: confirmed };
}

async function listingPriceFromForm(page) {
  const listing = page.locator('#listing_price').first();
  if (!(await listing.count())) return 0;
  return parseMoney(await listing.inputValue().catch(() => '0'));
}

/**
 * saveEvaluation / skipEvaluation / updateCertification all refuse Ready For
 * Sale when listing_price is 0 or null. Override a zero price before those
 * submits, then confirm the saved value from getlead.
 */
async function ensureListingPrice(page, { alreadyOnDetails = false, submit = true } = {}) {
  if (!alreadyOnDetails) await openStockTab(page, 'STOCK DETAIL');
  await expect(page.locator('form')).toBeVisible({ timeout: 20000 });

  const state = await readStockState(page);
  const formValue = await listingPriceFromForm(page);
  const current = parseMoney(state.listingPrice) || formValue;
  if (current > 0) {
    console.log(`[stock] Listing price ₹${Math.round(current).toLocaleString('en-IN')} is already set.`);
    return { listingPrice: current, updated: false };
  }

  const indicative = await page.locator('#price_indicative').first().inputValue().catch(() => '')
    || state.indicativePrice;
  const next = replacementListingPrice(indicative);
  console.log(`[stock] Listing price is 0 — overriding with ₹${next.toLocaleString('en-IN')}.`);

  const listing = page.locator('#listing_price').first();
  await expect(listing).toBeVisible({ timeout: 20000 });
  await listing.click({ force: true }).catch(() => {});
  await listing.fill(String(next), { force: true });
  await listing.dispatchEvent('input').catch(() => {});
  await listing.dispatchEvent('change').catch(() => {});

  if (!submit) return { listingPrice: next, updated: true };

  const submitButton = await visibleActionButton(page, /^(Submit|Confirm)$/i);
  if (await submitButton.isVisible().catch(() => false)) {
    const response = await clickAndSave(page, {
      names: /^(Submit|Confirm)$/i,
      responseTest: (body, post) => /stock details (updated|not updated)/i.test(body?.msg || '')
      || /updatelead/i.test(post || ''),
    });
    const body = response ? await response.json().catch(() => ({})) : {};
    if (!response || response.status() !== 200 || body.status !== 'ok') {
      throw new Error(
        `Could not save a non-zero listing price. ${body.msg || 'No successful API response.'}`
      );
    }
  } else {
    console.log('[stock] Stock details Submit is not available; filled listing price in the form only.');
  }

  const saved = await confirmListingPrice(page);
  return { listingPrice: saved, updated: true };
}

async function confirmListingPrice(page) {
  let latest = {};
  await expect.poll(async () => {
    latest = await readStockState(page);
    return parseMoney(latest.listingPrice);
  }, {
    timeout: 20000,
    intervals: [400, 800, 1200],
    message: 'Listing price is still 0 after save; Ready For Sale would be refused.',
  }).toBeGreaterThan(0);
  console.log(`[stock] Confirmed listing price ₹${Math.round(latest.listingPrice).toLocaleString('en-IN')}.`);
  return latest.listingPrice;
}

function isForbiddenRefurbLabel(value) {
  return /(?:^|\s)not\s*[- ]?\s*ok(?:$|\s)|refurbishment\s+not\s+done/i
    .test(String(value || ''));
}

function isAllowedRefurbLabel(value) {
  return /^(?:ok|yes|no|n\/?a|not applicable|to be checked later)$/i
    .test(String(value || '').trim());
}

async function radioLabel(radio) {
  const id = await radio.getAttribute('id');
  if (id) {
    const label = radio.locator(`xpath=following-sibling::label[@for="${id}"][1]`);
    if (await label.count()) return (await label.innerText()).trim();
  }
  return (await radio.evaluate((node) =>
    node.closest('label')?.innerText
    || node.parentElement?.innerText
    || node.value
  )).trim();
}

async function chooseCertificationSafeAnswer(row) {
  const radios = row.locator('input[type="radio"][name^="rg-"]:not([disabled])');
  const count = await radios.count();
  if (!count) {
    const input = row.locator('.col-sm-4 input[type="text"]:not([disabled])').first();
    if (!(await input.isVisible().catch(() => false))) return '';
    const placeholder = await input.getAttribute('placeholder') || '';
    const value = /video|url|link/i.test(placeholder)
      ? 'https://www.youtube.com/watch?v=post-refurbishment'
      : String(1 + Math.floor(Math.random() * 9));
    await input.fill(value);
    return value;
  }

  const candidates = [];
  for (let i = 0; i < count; i++) {
    const radio = radios.nth(i);
    const label = await radioLabel(radio);
    const value = await radio.getAttribute('value') || '';
    if (!isForbiddenRefurbLabel(label) && !isForbiddenRefurbLabel(value)) {
      candidates.push({ radio, label, value });
    }
  }
  const chosen = candidates.find((item) => /^ok$/i.test(item.label))
    || candidates.find((item) => /^yes$/i.test(item.label))
    || candidates.find((item) => isAllowedRefurbLabel(item.label))
    || candidates[0];
  if (!chosen) {
    throw new Error(`No certification-safe option exists for "${(await row.innerText()).slice(0, 100)}".`);
  }
  await chosen.radio.check({ force: true }).catch(() => chosen.radio.click({ force: true }));
  return chosen.label || chosen.value;
}

async function fillRefurbDependents(row) {
  const checks = row.locator('input[type="checkbox"]:not([disabled])');
  if (await checks.count() && !(await row.locator('input[type="checkbox"]:checked').count())) {
    await checks.first().check({ force: true });
  }
  const subRadios = row.locator('input[type="radio"]:not([name^="rg-"]):not([disabled])');
  if (await subRadios.count() && !(await row.locator('input[type="radio"]:not([name^="rg-"]):checked').count())) {
    await subRadios.first().check({ force: true });
  }
  const remarks = row.locator('textarea[placeholder*="remarks" i]:not([disabled])').first();
  if (await remarks.isVisible().catch(() => false)) {
    await remarks.fill('Checked after refurbishment and found in acceptable condition.');
  }
  return { cost: await fillRandomRefurbCost(row) };
}

async function readStockState(page) {
  return page.evaluate(async () => {
    const parts = location.pathname.split('/').filter(Boolean);
    const detailIndex = parts.indexOf('detail');
    const id = detailIndex >= 0 ? parts[detailIndex + 1] : '';
    const segment = parts[0] === 'admin' ? 'admin/my-stock' : 'my-stock';
    if (!id) return { error: 'Stock ID is missing from the detail URL.' };
    try {
      const response = await window.$http(
        'POST',
        `${window.g.$base_url_api}/${segment}`,
        { action: 'getlead', id }
      );
      const detail = response?.body?.data?.detail || {};
      return {
        id,
        status: Number(detail.status || 0),
        statusName: detail.status_name || '',
        isCertifiable: detail.is_certifiable === 'y',
        isBrandGroup: detail.is_brand_group === 'y',
        evaluationDone: detail.evaluation_done === 'y',
        refurbishmentNotDone: detail.evaluation_not_done === 'y',
        certificationCriteriaFlag: detail.certification_criteria_flag || '',
        certificationType: String(detail.certification_type || ''),
        listingPrice: Number(detail.listing_price || 0),
        indicativePrice: detail.price_indicative || '',
      };
    } catch (error) {
      return {
        error: error?.body?.msg || error?.message || 'Could not read stock state.',
      };
    }
  });
}

async function waitForStockStatus(page, expectedStatus, label) {
  let latest = {};
  await expect.poll(async () => {
    latest = await readStockState(page);
    return latest.status;
  }, {
    timeout: 25000,
    intervals: [500, 1000, 1500],
    message: `Stock did not reach ${label}`,
  }).toBe(expectedStatus);
  console.log(`[stock] Status confirmed: ${label} (${expectedStatus}).`);
  return latest;
}

async function preparePostRefurbishmentSections(page) {
  const skipped = await page.evaluate((labels) => {
    const normalized = labels.map((label) => label.toLowerCase());
    const names = [];
    document.querySelectorAll('.accordion').forEach((section) => {
      const button = section.querySelector('.accordion-button');
      const label = (button?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!normalized.some((item) => label.toLowerCase().includes(item))) return;
      section.setAttribute('data-dms-skip-section', 'true');
      names.push(label);
    });
    return names;
  }, SKIPPED_SECTION_LABELS);
  if (skipped.length) console.log(`[stock] Skipping section(s): ${skipped.join(', ')}`);
  await expandEvaluationSections(page, { skipLabels: SKIPPED_SECTION_LABELS });
  return skipped;
}

async function refurbishmentNotDoneIsSet(page) {
  return page.evaluate(() => {
    const label = Array.from(document.querySelectorAll('label'))
      .find((node) => /refurbishment\s+not\s+done/i.test(node.innerText || ''));
    const wrapper = label?.closest('.form-check, .form-group, .col-12');
    return Boolean(wrapper?.querySelector('input[type="checkbox"]:checked'));
  }).catch(() => false);
}

async function postRefurbishmentEvaluation(page) {
  await openStockTab(page, 'REFURBISHMENT DETAILS');
  const missing = toast(page).filter({ hasText: /Evaluation template not found/i });
  if (await missing.isVisible().catch(() => false)) {
    throw new Error(
      'Post-refurbishment template not found. The stock make/fuel does not match an active evaluation template.'
    );
  }
  await expect(page.getByText(/Post-Refurbishment Evaluation Checklist/i)).toBeVisible({ timeout: 20000 });
  await dismissLatestEvalModal(page);
  const initialState = await readStockState(page);
  const refurbishmentNotDone = initialState.refurbishmentNotDone
    || await refurbishmentNotDoneIsSet(page);
  if (refurbishmentNotDone) {
    console.log('[stock] Refurbishment Not Done is set; checklist skipped and JLR Approved is disallowed.');
    return {
      skipped: true,
      submitted: false,
      notOkCount: 0,
      refurbishmentNotDone: true,
      certificationCriteriaPass: false,
      evaluationDone: initialState.evaluationDone,
    };
  }
  const alreadyDone = initialState.evaluationDone
    || await isEvaluationCompleted(page);
  if (alreadyDone) {
    console.log(`[stock] Post-refurbishment already completed (${alreadyDone === true ? 'evaluation_done' : alreadyDone}) — skipping and opening Certification.`);
    return {
      skipped: true,
      submitted: false,
      notOkCount: 0,
      refurbishmentNotDone: false,
      certificationCriteriaPass: initialState.certificationCriteriaFlag !== 'n',
      evaluationDone: true,
    };
  }

  const skippedSections = await preparePostRefurbishmentSections(page);

  const rows = page.locator('.accordion:not([data-dms-skip-section="true"]) .eve-outer');
  const count = await rows.count();
  if (!count) {
    throw new Error(
      'No post-refurbishment questions were loaded. Verify that stock Make and Fuel match an active evaluation template.'
    );
  }
  console.log(`[stock] Post-refurbishment questions: ${count}`);
  await logSectionProgress(page, 'Sections before');
  const amounts = [];
  let answered = 0;
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await ensureRowVisible(page, row))) {
      console.log(`  Question ${i + 1} is still hidden; skipped.`);
      continue;
    }
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const answer = await chooseCertificationSafeAnswer(row);
    if (isForbiddenRefurbLabel(answer)) {
      throw new Error(`Refusing to submit Not OK for post-refurbishment question ${i + 1}.`);
    }
    answered += 1;
    await page.waitForTimeout(100);
    const { cost } = await fillRefurbDependents(row);
    if (cost) amounts.push(Number(cost));
  }
  console.log(`[stock] Answered ${answered}/${count} post-refurbishment questions`);
  await logSectionProgress(page, 'Sections after');
  if (amounts.length) {
    const total = amounts.reduce((sum, value) => sum + value, 0);
    console.log(`[stock] Random Act. Ref. Exp on ${amounts.length}/${count} questions, total ₹${total.toLocaleString('en-IN')}`);
  }

  const selectedNotOk = await rows.locator('input[type="radio"][name^="rg-"]:checked').evaluateAll(
    (nodes) => nodes.filter((node) => {
      const label = node.closest('label')?.innerText || node.parentElement?.innerText || node.value;
      return /not\s*[- ]?\s*ok/i.test(label);
    }).length
  );
  if (selectedNotOk) throw new Error('A Not OK refurbishment answer is selected; certification would fail.');

  const submit = page.getByRole('button', { name: /^Submit$/i }).last();
  const responsePromise = page.waitForResponse(async (response) => {
    if (response.request().method() !== 'POST') return false;
    try {
      const body = await response.json();
      return /checklist/i.test(body?.msg || '');
    } catch {
      return false;
    }
  }, { timeout: 30000 }).catch(() => null);
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
  const response = await responsePromise;
  const body = response ? await response.json().catch(() => ({})) : {};
  if (!response || response.status() !== 200 || body.status !== 'ok') {
    const error = await page.locator('.invalid-feedback.d-block, .alert-danger').first().textContent().catch(() => '');
    const message = body.msg || error || 'No successful API response.';
    if (/listing price/i.test(message)) {
      await ensureListingPrice(page);
      throw new Error(
        `Post-refurbishment was refused because listing price was 0. `
        + `A non-zero listing price is now saved — re-run to submit the checklist. ${message}`
      );
    }
    throw new Error(`Post-refurbishment evaluation failed. ${message}`);
  }
  console.log(`[stock] Submitted ${count} post-refurbishment answers with no Not OK selections.`);
  const finalState = await readStockState(page);
  return {
    skipped: false,
    submitted: true,
    notOkCount: 0,
    refurbishmentNotDone: false,
    certificationCriteriaPass: finalState.certificationCriteriaFlag !== 'n',
    skippedSections,
    resultingStatus: finalState.status,
    evaluationDone: finalState.evaluationDone || true,
  };
}

async function readCertificationCriteria(page) {
  const state = await readStockState(page);
  await openStockTab(page, 'CERTIFICATION');
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const ageMatch = text.match(/Vehicle Age\s*([0-9.]+)\s*years/i);
  const mileageMatch = text.match(/Vehicle Mileage\s*([0-9,]+)/i);
  const ageMet = /Age Criteria Met\s*yes/i.test(text);
  const mileageMet = /Mileage Criteria Met\s*yes/i.test(text);
  const approvedOptionEnabled = await page.locator('#certification_type.selectsearch-wrapper')
    .evaluate((element) => {
      const select = element.__vueSelectSearch;
      if (!select) return null;
      const approved = (select.allItems || []).find((item) =>
        /JLR Approved/i.test(String(item.label ?? item.name ?? ''))
      );
      if (!approved) return false;
      const value = String(approved.value ?? approved.id ?? '');
      const disabled = (select.disabledOptions || []).map(String);
      return !approved.disabled && approved.is_disabled !== 'y' && !disabled.includes(value);
    }).catch(() => null);
  return {
    isJlr: state.isCertifiable,
    ageYears: ageMatch ? Number(ageMatch[1]) : null,
    mileageKm: mileageMatch ? Number(mileageMatch[1].replace(/,/g, '')) : null,
    ageMet,
    mileageMet,
    approvedOptionEnabled,
    state,
  };
}

async function fillCertificationForm(page, approved) {
  const selectedType = await selectSearchOption(page, 'certification_type', {
    search: approved ? 'JLR Approved' : 'Non-Certified',
    label: approved ? 'JLR Approved' : 'Non-Certified',
    noFallback: true,
  });
  if (!selectedType) {
    throw new Error(`Could not select ${approved ? 'JLR Approved' : 'Non-Certified'} certification.`);
  }

  if (approved) {
    console.log('[stock] Certification type is JLR Approved — answering the checklist with Yes.');
    for (let i = 1; i <= 6; i++) {
      const yes = page.locator(`input[name="question${i}"][value="y"]`);
      if (await yes.isVisible().catch(() => false)) await yes.check({ force: true });
    }
  } else {
    console.log('[stock] Certification type is Non-Certified — leaving the Yes/No checklist unanswered.');
  }

  await fillIfVisible(
    page,
    'certification_remarks',
    approved
      ? 'JLR certification criteria verified by automation.'
      : 'Vehicle does not meet all JLR certification criteria.'
  );
}

async function submitCertification(page) {
  const responseTest = (body, post) => /certification/i.test(body?.msg || '')
    || /savecertification/i.test(post || '');
  const response = await clickAndSave(page, {
    names: /^(Confirm|Submit)$/i,
    expectConfirm: true,
    responseTest,
  });
  if (response) {
    const body = await response.json().catch(() => ({}));
    return { status: response.status(), body };
  }
  if (await acceptConfirmToast(page, 8000)) {
    const delayed = await page.waitForResponse(async (res) => {
      if (res.request().method() !== 'POST') return false;
      let body = {};
      try { body = await res.json(); } catch { body = {}; }
      let post = '';
      try { post = res.request().postData() || ''; } catch { post = ''; }
      return responseTest(body, post);
    }, { timeout: 20000 }).catch(() => null);
    if (delayed) {
      const body = await delayed.json().catch(() => ({}));
      return { status: delayed.status(), body };
    }
  }
  console.log('[stock] Confirm click did not return a certification response — submitting via API.');
  return submitCertificationViaApi(page);
}

async function submitCertificationViaApi(page) {
  return page.evaluate(async () => {
    const valueOf = (id) => {
      const element = document.getElementById(id);
      if (!element) return '';
      if (element.classList.contains('selectsearch-wrapper')) {
        const select = element.__vueSelectSearch;
        return String(select?.modelValue ?? select?.selectedItem?.value ?? select?.selectedItem?.id ?? '');
      }
      return element.value || '';
    };
    const data = new FormData();
    const parts = location.pathname.split('/').filter(Boolean);
    const detailIndex = parts.indexOf('detail');
    data.append('action', 'update');
    data.append('sub_action', 'savecertification');
    data.append('id', detailIndex >= 0 ? parts[detailIndex + 1] : '');
    ['certification_type', 'certified_by', 'certification_remarks', 'invoice_date',
      'date_of_warranty_start', 'date_of_sale', 'date_of_handover'].forEach((id) => {
      const value = valueOf(id);
      if (value) data.append(id, value);
    });
    for (let i = 1; i <= 6; i++) {
      const checked = document.querySelector(`input[name="question${i}"]:checked`);
      if (checked) data.append(`question${i}`, checked.value);
    }
    const segment = parts[0] === 'admin' ? 'admin/my-stock' : 'my-stock';
    try {
      const response = await window.$http('POST', `${window.g.$base_url_api}/${segment}`, data);
      return { status: response?.status, body: response?.body || {} };
    } catch (error) {
      return {
        status: error?.status || 0,
        body: error?.body || {},
        message: error?.message || 'Certification request failed',
      };
    }
  });
}

/**
 * Only JLR Approved certification needs images: savecertification runs
 * validate_mandatory_images() when certification_type = 1. Non-certified stock
 * never reaches that check, so uploading there would only burn requests.
 */
async function uploadImagesForCertifiedStock(page) {
  if (skipImagesOnLocalDms(page)) {
    console.log('[stock] Images skipped on dms.jlr.local; JLR Approved may be refused server-side.');
    return { skipped: true, reason: 'local-dms' };
  }
  console.log('[stock] JLR certified stock — uploading mandatory images before certification.');
  await openStockTab(page, 'IMAGES');
  await uploadMandatoryImages(page);
  return { skipped: false };
}

async function checkAndSubmitCertification(page, refurbishment) {
  const stateBefore = await readStockState(page);
  if (stateBefore.error) throw new Error(stateBefore.error);
  if (stateBefore.isCertifiable !== stateBefore.isBrandGroup) {
    throw new Error(
      'Stock make configuration is inconsistent: is_certifiable and is_brand_group disagree. '
      + 'The UI and backend would choose different JLR/non-JLR paths.'
    );
  }
  if (parseMoney(stateBefore.listingPrice) <= 0) {
    await ensureListingPrice(page);
  }
  if (stateBefore.status === INVENTORY_STATUS.READY_FOR_SALE) {
    console.log('[stock] Vehicle is already Ready For Sale; certification submission skipped.');
    return {
      isJlr: stateBefore.isCertifiable,
      eligible: stateBefore.certificationType === '1',
      submitted: false,
      alreadyReady: true,
      readyForSale: true,
      certificationType: !stateBefore.isCertifiable
        ? 'Not applicable (Non-JLR)'
        : (stateBefore.certificationType === '1' ? 'JLR Approved' : 'Non-Certified'),
      images: { skipped: true, reason: 'already-ready' },
    };
  }
  if (!stateBefore.isCertifiable) {
    const ready = await waitForStockStatus(
      page,
      INVENTORY_STATUS.READY_FOR_SALE,
      'Ready For Sale'
    );
    console.log('[stock] Non-JLR vehicle reached Ready For Sale after refurbishment; certification is not applicable.');
    return {
      isJlr: false,
      eligible: false,
      submitted: false,
      readyForSale: true,
      resultingStatus: ready.status,
      certificationType: 'Not applicable (Non-JLR)',
      images: { skipped: true, reason: 'not-jlr' },
      reason: 'not-jlr',
    };
  }

  const evaluationDone = stateBefore.evaluationDone
    || refurbishment.evaluationDone
    || refurbishment.skipped
    || refurbishment.submitted;
  if (!evaluationDone) {
    throw new Error('Post-refurbishment is not completed, so Certification cannot start.');
  }
  if (stateBefore.status !== INVENTORY_STATUS.CERTIFICATION_IN_PROGRESS
    && stateBefore.status !== INVENTORY_STATUS.READY_FOR_SALE) {
    console.log(
      `[stock] Post-refurbishment is done and inventory status is still ${stateBefore.status || 1}; `
      + 'opening Certification without waiting for status 2.'
    );
  } else {
    console.log(`[stock] Status confirmed: ${stateBefore.statusName || stateBefore.status}.`);
  }
  if (parseMoney((await readStockState(page)).listingPrice) <= 0) {
    await ensureListingPrice(page);
  }
  const criteria = await readCertificationCriteria(page);
  const refurbPass = refurbishment.notOkCount === 0
    && !refurbishment.refurbishmentNotDone
    && refurbishment.certificationCriteriaPass !== false
    && (refurbishment.skipped || refurbishment.submitted);
  const checklistPass = criteria.approvedOptionEnabled !== false;
  const eligible = refurbPass && checklistPass && criteria.ageMet && criteria.mileageMet;
  console.log(
    `[stock] Certification check: JLR=yes, refurbishment=${refurbPass && checklistPass ? 'pass' : 'fail'}, `
    + `age<${MAX_CERTIFICATION_AGE_YEARS}=${criteria.ageMet ? 'yes' : 'no'}, `
    + `mileage<${MAX_CERTIFICATION_MILEAGE_KM}=${criteria.mileageMet ? 'yes' : 'no'}.`
  );

  await fillCertificationForm(page, eligible);
  let images = { skipped: true, reason: 'not-jlr-approved' };
  if (eligible) {
    images = await uploadImagesForCertifiedStock(page);
    await readCertificationCriteria(page);
    await fillCertificationForm(page, eligible);
  } else {
    console.log('[stock] Images skipped: certification type is not JLR Approved.');
  }

  let result = await submitCertification(page);
  if (/listing price/i.test(result.body?.msg || result.message || '')) {
    await ensureListingPrice(page);
    await readCertificationCriteria(page);
    await fillCertificationForm(page, eligible);
    result = await submitCertification(page);
  }
  const submitted = result.status === 200 && result.body?.status === 'ok';
  if (submitted) {
    console.log(`[stock] Certification saved as ${eligible ? 'JLR Approved' : 'Non-Certified'}.`);
  } else {
    console.log(`[stock] Certification checked but not saved: ${result.body?.msg || result.message || 'request rejected'}`);
  }
  if (!submitted) {
    throw new Error(
      `Certification was not saved, so the vehicle cannot reach Ready For Sale. `
      + `${result.body?.msg || result.message || 'Request rejected.'}`
    );
  }
  const ready = await waitForStockStatus(
    page,
    INVENTORY_STATUS.READY_FOR_SALE,
    'Ready For Sale'
  );
  return {
    ...criteria,
    eligible,
    submitted,
    images,
    certificationType: eligible ? 'JLR Approved' : 'Non-Certified',
    message: result.body?.msg || result.message || '',
    readyForSale: true,
    resultingStatus: ready.status,
  };
}

async function runStockWorkflow(page) {
  await dismissAppModals(page);
  await page.goto('/my-stock', { waitUntil: 'networkidle' });
  await dismissAppModals(page);
  const stock = await chooseStockFromBrowser(page);
  await openChosenStock(page, stock);
  const details = await updateEnabledStockDetails(page);
  const before = await readStockState(page);
  if (before.error) throw new Error(before.error);
  if (before.isCertifiable !== before.isBrandGroup) {
    throw new Error(
      'Stock make configuration is inconsistent: is_certifiable and is_brand_group disagree. '
      + 'Correct master_makes before continuing.'
    );
  }
  console.log(
    `[stock] Vehicle type: ${before.isCertifiable ? 'JLR' : 'Non-JLR'}; `
    + `current status: ${before.statusName || before.status}.`
  );
  if (parseMoney(before.listingPrice) <= 0) {
    await ensureListingPrice(page);
  }
  const refurbishment = await postRefurbishmentEvaluation(page);
  const certification = await checkAndSubmitCertification(page, refurbishment);
  if (!certification.readyForSale) {
    throw new Error('Workflow ended before the vehicle reached Ready For Sale.');
  }
  return { stockId: stock.formatted, details, refurbishment, certification };
}

module.exports = {
  MAX_CERTIFICATION_AGE_YEARS,
  MAX_CERTIFICATION_MILEAGE_KM,
  INVENTORY_STATUS,
  normalizeStockId,
  collectVisibleStocks,
  chooseStockFromBrowser,
  updateEnabledStockDetails,
  postRefurbishmentEvaluation,
  checkAndSubmitCertification,
  runStockWorkflow,
};
