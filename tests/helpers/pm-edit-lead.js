/**
 * Purchase Master edit — separate from add-lead.
 * The user picks the lead in the Chrome window. The top grid row is never opened unless they choose that ID.
 */
const { expect } = require('@playwright/test');
const {
  normalizeLeadId,
  collectVisibleLeads,
  waitForCustomComponents,
  fillAllLeadDetails,
  fillVisibleDependents,
  submitLeadForm,
} = require('./purchase-lead');
const {
  dismissAppModals,
  selectIfVisible,
  fillIfVisible,
  pickDateIfVisible,
} = require('./form');
const { toast } = require('./login');
const { runStatusEvaluationAndImages } = require('./pm-evaluation');

const PICKER_ID = 'dms-edit-picker';

function pickTimeoutMs() {
  const fromEnv = Number(process.env.DMS_EDIT_PICK_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 10 * 60 * 1000;
}

function leadLabel(formatted) {
  return `Lead ID: ${formatted}`;
}

function matchingLeadRow(page, formatted) {
  const label = leadLabel(formatted);
  return page.locator('table.table tbody tr, table tbody tr, .mobilecard')
    .filter({ hasText: label });
}

async function removePicker(page) {
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
    delete window.__dmsEditChoice;
  }, PICKER_ID).catch(() => {});
}

async function showLeadPicker(page, leads) {
  await page.evaluate(({ id, leads: items }) => {
    document.getElementById(id)?.remove();
    window.__dmsEditChoice = null;

    const root = document.createElement('div');
    root.id = id;
    root.innerHTML = `
      <style>
        #${id} { position: fixed; top: 16px; right: 16px; width: 360px; max-height: calc(100vh - 32px);
          z-index: 2147483647; background: #111827; color: #f9fafb; border: 1px solid #374151;
          border-radius: 8px; font: 13px/1.4 Segoe UI, system-ui, sans-serif; overflow: auto; }
        #${id} * { box-sizing: border-box; }
        #${id} .hd { padding: 12px 14px 8px; border-bottom: 1px solid #374151; }
        #${id} h2 { margin: 0 0 4px; font-size: 15px; font-weight: 650; }
        #${id} .sub { color: #9ca3af; font-size: 12px; }
        #${id} .bd { padding: 12px 14px 14px; }
        #${id} label { display: block; margin-bottom: 6px; color: #d1d5db; }
        #${id} .row { display: flex; gap: 8px; }
        #${id} input[type=text] { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid #4b5563;
          border-radius: 6px; background: #1f2937; color: #f9fafb; }
        #${id} button { border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; font-weight: 600; }
        #${id} .go { background: #2563eb; color: #fff; }
        #${id} .ghost { background: #374151; color: #e5e7eb; }
        #${id} .err { color: #fca5a5; min-height: 16px; margin: 6px 0 10px; font-size: 12px; }
        #${id} .list { display: flex; flex-direction: column; gap: 6px; max-height: 340px; overflow: auto; }
        #${id} .lead { text-align: left; width: 100%; background: #1f2937; color: #f9fafb;
          border: 1px solid #374151; }
        #${id} .lead:hover { background: #1e3a5f; }
        #${id} .lead b { display: block; }
        #${id} .lead span { display: block; color: #9ca3af; font-weight: 400; font-size: 11px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #${id} .empty { color: #9ca3af; font-size: 12px; }
        #${id} .actions { display: flex; gap: 8px; margin-top: 12px; }
      </style>
      <div class="hd">
        <h2>Choose a lead to edit</h2>
        <div class="sub">Type a Lead ID or click one from the list. The top row is not used unless you pick it.</div>
      </div>
      <div class="bd">
        <label for="${id}-input">Lead ID (example: PM53)</label>
        <div class="row">
          <input id="${id}-input" type="text" placeholder="PM53" autocomplete="off" />
          <button type="button" class="go" data-act="typed">Continue</button>
        </div>
        <div class="err" id="${id}-err"></div>
        <div class="empty" id="${id}-count"></div>
        <div class="list" id="${id}-list"></div>
        <div class="actions">
          <button type="button" class="ghost" data-act="refresh">Refresh list from grid</button>
          <button type="button" class="ghost" data-act="cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const input = root.querySelector(`#${id}-input`);
    const err = root.querySelector(`#${id}-err`);
    const list = root.querySelector(`#${id}-list`);
    const count = root.querySelector(`#${id}-count`);

    const choose = (raw) => {
      const value = String(raw || '').trim();
      if (!value) {
        err.textContent = 'Enter or click a Lead ID first.';
        input.focus();
        return;
      }
      window.__dmsEditChoice = { action: 'pick', id: value };
    };

    count.textContent = items.length
      ? `${items.length} lead(s) on this page`
      : 'No leads on this page. Search the grid, then Refresh list.';

    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lead';
      btn.innerHTML = `<b>${item.id}</b><span>${item.summary || ''}</span>`;
      btn.addEventListener('click', () => choose(item.id));
      list.appendChild(btn);
    });

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        choose(input.value);
      }
    });
    root.querySelector('[data-act="typed"]').addEventListener('click', () => choose(input.value));
    root.querySelector('[data-act="refresh"]').addEventListener('click', () => {
      window.__dmsEditChoice = { action: 'refresh' };
    });
    root.querySelector('[data-act="cancel"]').addEventListener('click', () => {
      window.__dmsEditChoice = { action: 'cancel' };
    });
    input.focus();
  }, { id: PICKER_ID, leads });
}

async function chooseLeadFromBrowser(page) {
  const timeout = pickTimeoutMs();
  const deadline = Date.now() + timeout;
  console.log('\n[edit] Pick the lead in the Chrome panel on the right.');
  console.log('[edit] You can search the Purchase Master grid, then click Refresh list.');
  console.log(`[edit] Waiting up to ${Math.round(timeout / 1000)}s for your choice…`);

  while (Date.now() < deadline) {
    const leads = await collectVisibleLeads(page);
    if (leads.length) {
      console.log(`  Leads currently on the grid: ${leads.map((lead) => lead.id).join(', ')}`);
    } else {
      console.log('  No leads on the current grid page. Use Search, then Refresh list.');
    }

    await showLeadPicker(page, leads);
    const remaining = Math.max(5000, deadline - Date.now());
    const choice = await page.waitForFunction(() => window.__dmsEditChoice, null, { timeout: remaining })
      .then(() => page.evaluate(() => {
        const next = window.__dmsEditChoice;
        window.__dmsEditChoice = null;
        return next;
      }));

    if (!choice || choice.action === 'cancel') {
      await removePicker(page);
      throw new Error('Edit cancelled. No lead was opened.');
    }
    if (choice.action === 'refresh') {
      console.log('  Refreshing list from the grid…');
      await page.waitForLoadState('networkidle').catch(() => {});
      continue;
    }

    const leadId = normalizeLeadId(choice.id);
    if (!leadId.formatted) {
      console.log('  That is not a Lead ID. Try again (example: PM53).');
      continue;
    }
    await removePicker(page);
    console.log(`  You chose Lead ID ${leadId.formatted}`);
    return leadId;
  }

  await removePicker(page);
  throw new Error('Timed out waiting for a lead to be chosen in the browser.');
}

async function waitForLeadOnGrid(page, formatted) {
  const label = leadLabel(formatted);
  await page.getByText(label, { exact: false }).first().waitFor({ state: 'visible', timeout: 25000 });
  const row = matchingLeadRow(page, formatted).first();
  if (await row.count()) return row;

  const fallback = page.locator('tr, .mobilecard').filter({ hasText: label }).first();
  await expect(fallback).toBeVisible({ timeout: 10000 });
  return fallback;
}

async function applyGridSearch(page, term) {
  const input = page.locator('#search');
  await expect(input).toBeVisible({ timeout: 20000 });
  await input.click();
  await input.fill(term);
  await input.press('Tab');

  await page.locator('.search-filter').getByRole('button', { name: /^Search$/i }).first().click();
  await page.locator('.skeleton').first().waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
  await page.getByText(/Showing \d+/i).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
}

async function findLeadRow(page, leadId) {
  const { formatted } = leadId;
  const label = leadLabel(formatted);

  if (await page.getByText(label, { exact: false }).first().isVisible().catch(() => false)) {
    console.log(`  ${formatted} is already on this page — not using the top row.`);
    return waitForLeadOnGrid(page, formatted);
  }

  if (!page.url().includes('/purchase-master') || /\/detail\//.test(page.url())) {
    await page.goto('/purchase-master', { waitUntil: 'networkidle' });
    await dismissAppModals(page);
  }

  console.log(`  Searching the grid for ${formatted}…`);
  await applyGridSearch(page, formatted);
  try {
    const row = await waitForLeadOnGrid(page, formatted);
    const ids = (await collectVisibleLeads(page)).map((lead) => lead.id);
    console.log(`  Grid now shows: ${ids.join(', ') || formatted}`);
    return row;
  } catch (err) {
    const visible = await page.locator('table tbody tr, .mobilecard').allInnerTexts().catch(() => []);
    console.log(`  Grid rows after search:\n${visible.map((t) => `    ${t.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n') || '    (none)'}`);
    throw new Error(`Lead ID ${formatted} is not visible after search. Top row was not opened. ${err.message}`);
  }
}

async function clickViewLead(page, row, formatted) {
  const label = leadLabel(formatted);
  const view = row.getByRole('link', { name: /^View$/i })
    .or(row.getByRole('button', { name: /^View$/i }))
    .or(row.getByText(/^View$/i));
  console.log(`  Clicking View on ${formatted} only`);
  if (await view.first().isVisible().catch(() => false)) {
    await view.first().click();
  } else {
    const clicked = await page.evaluate((leadText) => {
      const rows = [...document.querySelectorAll('table tbody tr, .mobilecard')];
      const match = rows.find((el) => (el.innerText || '').includes(leadText));
      if (!match) return false;
      const btn = [...match.querySelectorAll('a, button')]
        .find((el) => /^view$/i.test((el.textContent || '').trim()));
      if (!btn) return false;
      btn.click();
      return true;
    }, label);
    if (!clicked) throw new Error(`View was not found on ${formatted}.`);
  }
  await expect(page).toHaveURL(/\/purchase-master\/detail\/[^/]+/, { timeout: 20000 });
  expect(page.url()).not.toMatch(/\/purchase-master\/detail\/?$/);
  console.log(`  Opened ${formatted} Lead Details → ${page.url()}`);
}

async function clickUpdateStatus(page, row, formatted) {
  const label = leadLabel(formatted);
  const rowText = (await row.innerText().catch(() => '')) || '';
  if (!rowText.includes(label) && !rowText.includes(formatted)) {
    throw new Error(`Matched row does not contain ${label}. Aborting so the top lead is not edited.`);
  }

  const updateStatus = row.getByRole('link', { name: /Update Status/i })
    .or(row.getByRole('button', { name: /Update Status/i }))
    .or(row.getByText(/Update Status/i));

  console.log(`  Clicking Update Status on ${formatted} only`);
  if (await updateStatus.first().isVisible().catch(() => false)) {
    await updateStatus.first().click();
  } else {
    const clicked = await page.evaluate((leadText) => {
      const rows = [...document.querySelectorAll('table tbody tr, .mobilecard')];
      const match = rows.find((el) => (el.innerText || '').includes(leadText));
      if (!match) return false;
      const btn = [...match.querySelectorAll('a, button, span[role="button"]')]
        .find((el) => /update\s*status/i.test(el.textContent || ''));
      if (!btn) return false;
      btn.click();
      return true;
    }, label);
    if (!clicked) throw new Error(`Update Status was not found on ${formatted}.`);
  }

  await expect(page).toHaveURL(/\/purchase-master\/detail\/.+\/status/, { timeout: 20000 });
  console.log(`  Opened ${formatted} via Update Status → ${page.url()}`);
}

async function openMatchingLead(page, leadId) {
  const { formatted } = leadId;
  await dismissAppModals(page);
  const row = await findLeadRow(page, leadId);
  await clickUpdateStatus(page, row, formatted);
}

async function fillAndSubmitStatus(page, testInfo) {
  await dismissAppModals(page);
  await expect(page.getByText(/Status of Lead|Lead Status|Update Status/i).first()).toBeVisible({ timeout: 20000 });

  const stamp = Date.now().toString().slice(-6);
  await selectIfVisible(page, 'status', { onlyIfEmpty: true, waitFor: 'sub_status' });
  await fillVisibleDependents(page, { stamp });
  await fillIfVisible(page, 'remarks', `Status updated by automation ${stamp}`);

  const update = page.getByRole('button', { name: /^UPDATE$/i }).last();
  await update.scrollIntoViewIfNeeded();
  await expect(update).toBeVisible({ timeout: 15000 });
  await update.click();

  await Promise.race([
    toast(page).filter({ hasText: /Updated successfully|successfully/i }).waitFor({ timeout: 25000 }),
    page.waitForURL(/\/purchase-master\/detail\/[^/]+/, { timeout: 25000 }),
  ]).catch(async () => {
    const err = await page.locator('.invalid-feedback, .alert-danger').first().textContent().catch(() => '');
    throw new Error(`Could not update status. ${err || 'No success toast.'}`);
  });
}

async function editChosenLead(page, testInfo) {
  console.log('\n→ Purchase Master edit: open the list so you can choose a lead');
  await dismissAppModals(page);
  await page.goto('/purchase-master', { waitUntil: 'networkidle' });
  await dismissAppModals(page);
  await expect(page.getByRole('button', { name: /Add Purchase Lead/i })).toBeVisible({ timeout: 20000 });

  const leadId = await chooseLeadFromBrowser(page);

  console.log(`→ Purchase Master edit: open ${leadId.formatted} Lead Details`);
  const row = await findLeadRow(page, leadId);
  await clickViewLead(page, row, leadId.formatted);
  await expect(page.getByRole('heading', { name: /Lead Details|Overview|STATUS/i }).first()).toBeVisible({ timeout: 20000 }).catch(() => {});
  await dismissAppModals(page);

  const sourceOnPage = page.locator('#source.selectsearch-wrapper');
  if (await sourceOnPage.isVisible().catch(() => false)) {
    await waitForCustomComponents(page);
    const stamp = Date.now().toString().slice(-6);
    console.log('→ Purchase Master edit: fill details and every visible dependent field');
    await fillAllLeadDetails(page, { stamp, keepExistingCustomer: true });
    await fillVisibleDependents(page, { stamp });
    console.log('→ Purchase Master edit: submit lead details');
    await submitLeadForm(page, testInfo, 'purchase-lead-edit-failed', { expectUpdate: true });
  } else {
    console.log('→ Purchase Master edit: Lead Details add form not on this tab — going to STATUS');
  }

  console.log('→ Purchase Master edit: STATUS → Evaluation → images');
  await runStatusEvaluationAndImages(page);

  console.log(`  Lead ${leadId.formatted} updated → ${page.url()}`);
  return { url: page.url(), leadId: leadId.formatted };
}

module.exports = {
  chooseLeadFromBrowser,
  openMatchingLead,
  editChosenLead,
};
