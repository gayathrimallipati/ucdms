/**
 * After Lead Details: open Status, move the lead to Evaluation,
 * complete the Evaluation tab, then upload mandatory Images-tab photos.
 */
const { expect } = require('@playwright/test');
const {
  selectIfVisible,
  fillIfVisible,
  pickDateIfVisible,
  currentSelectLabel,
  isSelectUnset,
  dismissAppModals,
  selectWrapper,
} = require('./form');
const { toast } = require('./login');
const { dummyImagePath, nextVehiclePhoto } = require('./vehicle-photos');

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Local Docker DMS — skip Images-tab uploads (S3/file storage is not set up). */
function skipImagesOnLocalDms(page) {
  const host = hostOf(page.url()) || hostOf(process.env.DMS_URL || 'https://dms.jlr.local');
  return host === 'dms.jlr.local' || host.endsWith('.dms.jlr.local');
}

async function openDetailTab(page, label) {
  await dismissAppModals(page);
  const tab = page.locator('#sidebar-menu-list a, .sidebar-container a, .sidebar-mobile-tabs a')
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') })
    .first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
  } else {
    const fromUrl = page.url().match(/(\/purchase-master\/detail\/[^/]+)/);
    if (!fromUrl) throw new Error(`Cannot open ${label}: not on a lead detail page.`);
    const key = label.toLowerCase().replace(/\s+/g, '_');
    await page.goto(`${fromUrl[1]}/${key === 'lead_detail' ? 'lead_detail' : key}`, { waitUntil: 'networkidle' });
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await dismissAppModals(page);
  console.log(`  Opened ${label} tab → ${page.url()}`);
}

async function submitStatusUpdate(page) {
  const update = page.locator('form button.btn-dark').filter({ hasText: /update/i })
    .or(page.getByRole('button', { name: /update/i }))
    .last();
  await expect(update).toBeVisible({ timeout: 20000 });
  await update.scrollIntoViewIfNeeded();
  await update.click();
  const confirm = page.getByRole('button', { name: /^(Yes|OK|Confirm)$/i });
  await confirm.first().waitFor({ state: 'visible', timeout: 3000 }).then(() => confirm.first().click()).catch(() => {});
  await Promise.race([
    toast(page).filter({ hasText: /Updated successfully|successfully/i }).waitFor({ timeout: 25000 }),
    page.locator('.invalid-feedback.d-block').first().waitFor({ state: 'visible', timeout: 8000 }),
  ]).catch(async () => {
    const err = await page.locator('.invalid-feedback.d-block, .alert-danger').first().textContent().catch(() => '');
    throw new Error(`Could not update status. ${err || 'No success toast.'}`);
  });
}

async function updateStatusToEvaluation(page) {
  await expect(page.getByText(/Status of Lead|Lead Status/i).first()).toBeVisible({ timeout: 20000 });

  const current = await currentSelectLabel(page, 'status');
  console.log(`  Current Status of Lead: ${current || '(empty)'}`);
  // Evaluation is the Follow up + Evaluation Scheduled bucket (not a main status).
  const status = /follow\s*up/i.test(current || '')
    ? current
    : await selectIfVisible(page, 'status', {
      search: 'Follow',
      label: 'Follow up',
      waitFor: 'sub_status',
    });
  console.log(`  Status of Lead: ${status || current || '(not set)'}`);

  const currentSub = await currentSelectLabel(page, 'sub_status');
  let sub = currentSub;
  if (!/evaluation\s*scheduled/i.test(currentSub || '')) {
    sub = await selectIfVisible(page, 'sub_status', {
      search: 'Evaluation',
      label: 'Evaluation Scheduled',
      noFallback: true,
    });
  }
  if (!/evaluat/i.test(sub || '')) {
    throw new Error(`Could not set Sub Status to Evaluation Scheduled (got "${sub || currentSub || ''}").`);
  }
  console.log(`  Sub Status: ${sub}`);

  await expect(selectWrapper(page, 'evaluation_place')).toBeVisible({ timeout: 15000 });
  const place = await selectIfVisible(page, 'evaluation_place', {
    label: 'Showroom',
    search: 'Showroom',
  });
  const classification = await selectIfVisible(page, 'lead_classification', {
    label: 'Hot',
    search: 'Hot',
  });
  await pickDateIfVisible(page, 'followup_date');
  await fillIfVisible(page, 'remarks', 'Moving this lead to evaluation. Inspection scheduled by automation.');

  const missing = [];
  if (await isSelectUnset(page, 'lead_classification')) missing.push('Lead Classification');
  if (await isSelectUnset(page, 'evaluation_place')) missing.push('Evaluation Place');
  const followup = await page.locator('label[for="followup_date"]').locator('xpath=following::div[contains(@class,"dtp-wrapper")][1]').locator('input.form-control').inputValue().catch(() => '');
  if (!followup || /^DD-MM-YYYY/i.test(followup)) missing.push('Next follow-up date');
  if (missing.length) {
    throw new Error(`Status of Lead still missing: ${missing.join(', ')}`);
  }
  console.log(`  Lead Classification: ${classification || 'set'}`);
  console.log(`  Evaluation Place: ${place || 'set'}`);
  console.log(`  Next follow-up date: ${followup}`);

  await submitStatusUpdate(page);

  const afterStatus = await currentSelectLabel(page, 'status');
  const afterSub = await currentSelectLabel(page, 'sub_status');
  const inEvaluation = /evaluat/i.test(`${afterStatus} ${afterSub} ${sub || ''}`);
  console.log(`  After update: ${afterStatus || ''} / ${afterSub || ''} (evaluation: ${inEvaluation ? 'yes' : 'no'})`);
  return inEvaluation;
}

/**
 * PM status ladder (common_config pm_status): Fresh 1 → Follow up 2 →
 * Deal Done 3 → Purchased 4. class_configs.php only enables the next step, the
 * API refuses Deal Done unless evaluation_done = 'y', and Purchased runs
 * validate_mandatory_images() on top of the form validation.
 */
const STATUS_PRICING = {
  price_customer: 1000000,
  price_expenses: 50000,
  price_quote: 950000,
  price_margin: 100000,
  price_agreed: 900000,
  token_amount: 25000,
  price_selling: 900000,
};

function watchStatusResponses(page) {
  const events = [];
  const handler = async (response) => {
    const request = response.request();
    if (request.method() !== 'POST') return;
    const url = request.url() || '';
    if (!/purchase-master/i.test(url)) return;
    let post = '';
    try {
      post = request.postData() || '';
    } catch {
      post = '';
    }
    // saveStatus() sends FormData (sub_action=updatestatus). Chromium does not
    // expose multipart postData, so "updatestatus" never appears in `post`.
    if (/uploadimages|getleadevaluation|getlist|getlead\b/i.test(post)) return;
    const type = request.headers()['content-type'] || '';
    const looksLikeStatus = /updatestatus/i.test(post)
      || /multipart\/form-data/i.test(type);
    if (!looksLikeStatus) return;

    const body = await response.json().catch(() => null);
    if (!body) return;
    const msg = String(body.msg || '');
    if (/image/i.test(msg) && /upload/i.test(msg)) return;
    const raw = body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : [];
    events.push({
      ok: response.status() === 200 && body.status === 'ok',
      msg,
      errors: raw.flat().map((e) => String(e).trim()).filter(Boolean),
    });
  };
  page.on('response', handler);
  return { events, dispose: () => page.off('response', handler) };
}

async function trySubmitStatus(page, watcher) {
  const seen = watcher.events.length;
  const update = page.locator('form button.btn-dark').filter({ hasText: /update/i })
    .or(page.getByRole('button', { name: /update/i }))
    .last();
  await expect(update).toBeVisible({ timeout: 20000 });
  await update.scrollIntoViewIfNeeded();
  await update.click();
  const confirm = page.getByRole('button', { name: /^(Yes|OK|Confirm)$/i });
  await confirm.first().waitFor({ state: 'visible', timeout: 3000 })
    .then(() => confirm.first().click()).catch(() => {});

  const successToast = toast(page).filter({ hasText: /Updated successfully|Status updated successfully/i });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const fresh = watcher.events.slice(seen);
    if (fresh.some((e) => e.ok)) return { ok: true, errors: [] };
    const failed = fresh.find((e) => !e.ok);
    if (failed) return { ok: false, errors: failed.errors.length ? failed.errors : [failed.msg] };
    if (await successToast.isVisible().catch(() => false)) return { ok: true, errors: [] };
    const inline = (await page.locator('.invalid-feedback.d-block').allInnerTexts().catch(() => []))
      .map((t) => t.trim()).filter(Boolean);
    if (inline.length) return { ok: false, errors: inline };
    await page.waitForTimeout(400);
  }
  const inline = (await page.locator('.invalid-feedback.d-block').allInnerTexts().catch(() => []))
    .map((t) => t.trim()).filter(Boolean);
  return { ok: false, errors: inline };
}

async function attachStatusDoc(page, fieldId) {
  const input = page.locator(`input#${fieldId}[type="file"]`);
  if (!(await input.count())) return false;
  await input.setInputFiles(nextVehiclePhoto());
  return true;
}

/** Upload STATUS file fields that show a red * and do not already have a file. */
async function attachRequiredStatusDocs(page) {
  const labels = page.locator('label.form-label').filter({
    has: page.locator('.text-danger'),
  });
  const count = await labels.count();
  const attached = [];
  for (let i = 0; i < count; i++) {
    const label = labels.nth(i);
    const forId = await label.getAttribute('for');
    if (!forId) continue;
    const input = page.locator(`input#${forId}[type="file"]`);
    if (!(await input.count())) continue;
    if (!(await input.isVisible().catch(() => false))) continue;
    const name = (await label.innerText()).replace(/\*/g, '').trim();
    await input.setInputFiles(nextVehiclePhoto());
    attached.push(name || forId);
    console.log(`  Uploaded mandatory ${name || forId}`);
  }
  return attached;
}

/**
 * Changing status clears sub_status / followup_date / remarks, so always fill
 * after picking the new status.
 */
async function fillStatusRequirements(page, target) {
  const isDealDone = /deal\s*done/i.test(target);
  const isPurchased = /purchas/i.test(target);

  if (await selectWrapper(page, 'sub_status').isVisible().catch(() => false)) {
    if (await isSelectUnset(page, 'sub_status')) {
      await selectIfVisible(page, 'sub_status', isDealDone
        ? { label: 'Token Paid', search: 'Token' }
        : {});
    }
  }

  await selectIfVisible(page, 'lead_classification', { label: 'Hot', search: 'Hot', onlyIfEmpty: true });
  await fillIfVisible(page, 'remarks', `Lead moved to ${target} by automation after evaluation.`, { onlyIfEmpty: true });
  await pickDateIfVisible(page, 'followup_date').catch(() => {});

  for (const [field, value] of Object.entries(STATUS_PRICING)) {
    await fillIfVisible(page, field, value, { onlyIfEmpty: true });
  }

  if (isPurchased) {
    const noExchange = page.locator('#is_exchange_n');
    if (await noExchange.isVisible().catch(() => false)) {
      await noExchange.check({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(400);
    const docs = await attachRequiredStatusDocs(page);
    if (!docs.length) {
      if (await attachStatusDoc(page, 'file_doc1')) {
        console.log('  Uploaded mandatory Price Agreement');
      }
    }
  }
}

function isImageValidationError(errors) {
  return /image|photo|mandatory/i.test((errors || []).join(' '));
}

async function selectAndFillStatus(page, target) {
  await selectIfVisible(page, 'status', {
    label: target,
    search: target.split(' ')[0],
    noFallback: true,
  });
  const now = (await currentSelectLabel(page, 'status')) || '';
  if (!new RegExp(target.replace(/\s+/g, '\\s*'), 'i').test(now)) {
    console.log(`  "${target}" is not selectable (status still ${now || 'unset'}) — transition blocked`);
    return false;
  }
  await fillStatusRequirements(page, target);
  return true;
}

async function moveStatusTo(page, target, watcher) {
  const isPurchased = /purchas/i.test(target);
  if (isPurchased) {
    const images = await ensureMandatoryImagesForPurchase(page);
    if (!images.ready) {
      console.log(`  Cannot move to Purchased until mandatory Images-tab photos are saved`);
      return false;
    }
  }

  if (!(await selectAndFillStatus(page, target))) return false;
  const result = await trySubmitStatus(page, watcher);
  if (result.ok) {
    console.log(`  Status of Lead → ${target}`);
    return true;
  }

  if (isPurchased && isImageValidationError(result.errors)) {
    console.log(`  Purchased refused for missing images — uploading and retrying`);
    const images = await ensureMandatoryImagesForPurchase(page);
    if (images.ready && await selectAndFillStatus(page, target)) {
      const retry = await trySubmitStatus(page, watcher);
      if (retry.ok) {
        console.log(`  Status of Lead → ${target}`);
        return true;
      }
      console.log(`  Could not move to ${target} after image retry: ${retry.errors.join(' | ') || 'no error reported'}`);
      return false;
    }
  }

  console.log(`  Could not move to ${target}: ${result.errors.join(' | ') || 'no error reported'}`);
  return false;
}

/** Walk the lead one status at a time until it is Purchased. */
async function advanceLeadStatusToPurchased(page) {
  const watcher = watchStatusResponses(page);
  try {
    for (let step = 0; step < 4; step++) {
      await openDetailTab(page, 'STATUS');
      const current = (await currentSelectLabel(page, 'status')) || '';
      if (/purchas/i.test(current)) {
        console.log('  Status of Lead is Purchased');
        return 'Purchased';
      }
      if (/lost/i.test(current)) {
        console.log('  Status of Lead is Lost — final status, stopping');
        return current;
      }

      const target = /deal\s*done/i.test(current)
        ? 'Purchased'
        : (/follow\s*up/i.test(current) ? 'Deal Done' : 'Follow up');
      console.log(`→ Purchase Master: move status ${current || '(unset)'} → ${target}`);
      if (!(await moveStatusTo(page, target, watcher))) return current;
    }
    return (await currentSelectLabel(page, 'status')) || '';
  } finally {
    watcher.dispose();
  }
}

async function dismissLatestEvalModal(page) {
  const dialog = page.locator('.modal.show.d-block, .modal.fade.show.d-block').filter({
    hasText: /Latest Evaluation Details|most recent evaluation/i,
  });
  const ok = dialog.getByRole('button', { name: /^OK$/i });

  await Promise.race([
    ok.waitFor({ state: 'visible', timeout: 15000 }),
    page.locator('.eve-outer').first().waitFor({ state: 'visible', timeout: 15000 }),
    page.locator('.skeleton').first().waitFor({ state: 'hidden', timeout: 15000 }),
  ]).catch(() => {});

  if (!(await ok.isVisible().catch(() => false))) {
    await page.waitForTimeout(500);
  }
  if (!(await ok.isVisible().catch(() => false))) return false;

  await ok.click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  console.log('  Latest Evaluation Details: clicked OK — continuing evaluation');
  return true;
}

/**
 * Every section must be open before answering: the accordion body is v-show, so
 * questions in a collapsed section are in the DOM but hidden and cannot be
 * checked. Snapshot the collapsed buttons and click them in one pass — indexing
 * a live `.collapsed` locator silently stops after the first section, because
 * expanding one drops it out of the match set.
 */
async function expandEvaluationSections(page, options = {}) {
  await dismissLatestEvalModal(page);
  const skippedLabels = (options.skipLabels || []).map((label) => String(label).trim().toLowerCase());
  let previous = Infinity;
  for (let pass = 0; pass < 10; pass++) {
    const remaining = await page.evaluate((labels) => {
      const collapsed = Array.from(document.querySelectorAll('.accordion-button.collapsed'))
        .filter((button) => !labels.some((label) =>
          (button.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().includes(label)
        ));
      collapsed.forEach((button) => button.click());
      return collapsed.length;
    }, skippedLabels).catch(() => 0);
    if (!remaining) return;
    await page.waitForTimeout(250);
    const still = await page.locator('.accordion-button.collapsed').evaluateAll(
      (buttons, labels) => buttons.filter((button) => !labels.some((label) =>
        (button.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().includes(label)
      )).length,
      skippedLabels
    ).catch(() => 0);
    if (!still) return;
    if (still >= previous) {
      console.log(`  ${still} section(s) stayed collapsed and will be opened per question.`);
      return;
    }
    previous = still;
  }
}

/**
 * Last-resort guard for a question whose section is still collapsed.
 */
async function ensureRowVisible(page, row) {
  if (await row.isVisible().catch(() => false)) return true;
  const clicked = await row.evaluate((el) => {
    const button = el.closest('.accordion-item')?.querySelector('.accordion-button.collapsed');
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(250);
  return row.isVisible().catch(() => false);
}

async function logSectionProgress(page, label) {
  const sections = await page.locator('.accordion-button').evaluateAll(
    (nodes) => nodes.map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim())
  ).catch(() => []);
  if (sections.length) console.log(`  ${label}: ${sections.join(' | ')}`);
}

function isNotOkLabel(text) {
  return /not\s*ok|not\s*okay|\bnok\b/i.test(String(text || ''));
}

async function radioChoiceLabel(radio) {
  return radio.evaluate((el) => {
    const wrap = el.closest('span.d-flex, .form-check, label') || el.parentElement;
    return (wrap?.innerText || el.value || '').trim();
  }).catch(() => '');
}

function isOkLabel(text) {
  const t = String(text || '').trim();
  if (isNotOkLabel(t)) return false;
  return /^(ok|okay|yes|good|pass)$/i.test(t) || /\bok\b/i.test(t);
}

function pickEvaluationStrategy() {
  const forced = String(process.env.DMS_EVAL_STRATEGY || '').toLowerCase();
  if (forced === 'ok' || forced === 'all-ok') return 'all-ok';
  if (forced === 'notok' || forced === 'all-not-ok') return 'all-not-ok';
  if (forced === 'mixed') return 'mixed';
  const roll = Math.random();
  if (roll < 1 / 3) return 'all-ok';
  if (roll < 2 / 3) return 'all-not-ok';
  return 'mixed';
}

async function selectOkOrNotOk(row, wantNotOk) {
  const radios = row.locator('input.form-check-input[type="radio"][name^="rg-"]:not([disabled])');
  const n = await radios.count();
  if (!n) return { selected: '', isNotOk: false };

  let okRadio = null;
  let notOkRadio = null;
  const labels = [];
  for (let i = 0; i < n; i++) {
    const radio = radios.nth(i);
    const text = await radioChoiceLabel(radio);
    const value = await radio.getAttribute('value');
    labels.push(text);
    if (isNotOkLabel(text) || isNotOkLabel(value)) notOkRadio = { radio, text };
    else if (isOkLabel(text) || isOkLabel(value)) okRadio = { radio, text };
  }

  const chosen = wantNotOk
    ? (notOkRadio || okRadio || { radio: radios.first(), text: labels[0] || '' })
    : (okRadio || notOkRadio || { radio: radios.first(), text: labels[0] || '' });
  const already = await chosen.radio.isChecked().catch(() => false);
  if (!already) {
    await chosen.radio.check({ force: true }).catch(() => chosen.radio.click({ force: true }));
  }
  const selected = chosen.text || await radioChoiceLabel(chosen.radio);
  return { selected, isNotOk: isNotOkLabel(selected) };
}

/**
 * Numeric / video_url questions have no radios — imgData is still required.
 */
async function answerInputQuestion(row) {
  const input = row.locator('.col-sm-4 input[type="text"]').first();
  if (!(await input.count()) || !(await input.isVisible().catch(() => false))) return '';
  const current = (await input.inputValue().catch(() => '')).trim();
  if (current) return current;
  const placeholder = (await input.getAttribute('placeholder')) || '';
  const maxLength = await input.getAttribute('maxlength');
  const isVideo = /video|url|link/i.test(placeholder) || (maxLength && Number(maxLength) > 6);
  const value = isVideo
    ? 'https://www.youtube.com/watch?v=evaluation'
    : String(1 + Math.floor(Math.random() * 9));
  await input.fill(value);
  return value;
}

/**
 * Est./Act. Ref. Exp is optional (isRequired false in class_sellleads.php and
 * class_inventory.php), digits only, maxlength 9. Give a random amount to a
 * random subset of questions and leave the rest blank, which is what a real
 * inspection looks like. DMS_REFURB_COST_CHANCE (0..1) overrides how many get
 * one; 0 disables amounts entirely.
 */
const REFURB_COST_MIN = 500;
const REFURB_COST_MAX = 75000;
const REFURB_COST_STEP = 500;

function refurbCostChance() {
  const value = Number(process.env.DMS_REFURB_COST_CHANCE);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5;
}

function randomRefurbCost() {
  const steps = Math.floor((REFURB_COST_MAX - REFURB_COST_MIN) / REFURB_COST_STEP) + 1;
  return String(REFURB_COST_MIN + Math.floor(Math.random() * steps) * REFURB_COST_STEP);
}

async function fillRandomRefurbCost(row) {
  const cost = row.locator('input[placeholder*="Ref. Exp" i]:not([disabled])').first();
  if (!(await cost.isVisible().catch(() => false))) return null;
  const current = (await cost.inputValue().catch(() => '')).trim();
  if (current) return current;
  if (Math.random() >= refurbCostChance()) return null;
  const amount = randomRefurbCost();
  // fill() dispatches input, so v-model and the totalRFCost handler stay in sync.
  await cost.fill(amount);
  return amount;
}

/**
 * Sub-options and remarks are configured per option (subOptionsRequired /
 * remarksRequired in class_evaluation-checklist.php), so OK can need them too.
 * Fill whatever the selected option renders.
 */
async function fillQuestionDependents(row, notOk) {
  const subChecks = row.locator('input.form-check-input[type="checkbox"]:not([disabled])');
  const visibleChecks = [];
  const checkCount = await subChecks.count();
  for (let i = 0; i < checkCount; i++) {
    const box = subChecks.nth(i);
    if (await box.isVisible().catch(() => false)) visibleChecks.push(box);
  }

  if (visibleChecks.length) {
    const anyChecked = await Promise.all(visibleChecks.map((b) => b.isChecked().catch(() => false)));
    if (!anyChecked.some(Boolean)) {
      const box = visibleChecks[Math.floor(Math.random() * visibleChecks.length)];
      await box.check({ force: true }).catch(() => box.click({ force: true }));
    }
  } else {
    const subRadios = row.locator('input.form-check-input[type="radio"]:not([name^="rg-"]):not([disabled])');
    const radioCount = await subRadios.count();
    if (radioCount) {
      const checked = await row.locator('input.form-check-input[type="radio"]:not([name^="rg-"]):checked').count();
      if (!checked) {
        const pick = subRadios.nth(Math.floor(Math.random() * radioCount));
        await pick.check({ force: true }).catch(() => pick.click({ force: true }));
      }
    }
  }

  const remarks = row.locator('textarea[placeholder*="remarks" i]').first();
  if (await remarks.isVisible().catch(() => false)) {
    const current = (await remarks.inputValue().catch(() => '')).trim();
    if (!current) {
      await remarks.fill(notOk
        ? 'Not OK. Defect noted during inspection. Remarks added as required.'
        : 'OK. Checked during inspection and found in acceptable condition.');
    }
  }

  return { cost: await fillRandomRefurbCost(row) };
}

/**
 * Re-fill any question the app flagged (sub-option / remarks / option required).
 */
async function fixFlaggedQuestions(page) {
  const flagged = page.locator('.eve-outer').filter({ has: page.locator('.invalid-feedback.d-block') });
  const n = await flagged.count();
  if (!n) return 0;
  for (let i = 0; i < n; i++) {
    const row = flagged.nth(i);
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const answered = await row.locator('input.form-check-input[type="radio"][name^="rg-"]:checked').count();
    let notOk = false;
    if (!answered) {
      const picked = await selectOkOrNotOk(row, false);
      notOk = picked.isNotOk;
      if (!picked.selected) await answerInputQuestion(row);
      await page.waitForTimeout(150);
    } else {
      const label = await radioChoiceLabel(row.locator('input.form-check-input[type="radio"][name^="rg-"]:checked').first());
      notOk = isNotOkLabel(label);
    }
    await fillQuestionDependents(row, notOk);
  }
  console.log(`  Fixed ${n} flagged question(s) and retrying submit`);
  return n;
}

async function submitChecklist(page) {
  const submit = page.getByRole('button', { name: /^Submit$/i }).last();
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeVisible({ timeout: 15000 });
  await submit.click();
  return Promise.race([
    toast(page).filter({ hasText: /Checklist updated|successfully/i }).waitFor({ timeout: 25000 }).then(() => true),
    toast(page).filter({ hasText: /required|failed/i }).waitFor({ timeout: 12000 }).then(() => false),
  ]).catch(() => false);
}

/**
 * Evaluation is done when evaluation_done = 'y' (Download Report renders),
 * the overview badge says Completed, or the checklist came back read-only.
 */
async function isEvaluationCompleted(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  if (await page.getByRole('button', { name: /Download Report/i }).isVisible().catch(() => false)) {
    return 'evaluation_done';
  }

  const badge = page.locator('.badge.bg-dark.rounded-pill')
    .filter({ hasText: /^(Completed|In-Progress|Pending)$/i }).first();
  if (await badge.isVisible().catch(() => false)) {
    const text = (await badge.innerText()).trim();
    if (/completed/i.test(text)) return 'status Completed';
  }

  const options = page.locator('input.form-check-input[type="radio"][name^="rg-"]');
  if (await options.count()) {
    const editable = await page.locator('input.form-check-input[type="radio"][name^="rg-"]:not([disabled])').count();
    if (!editable) return 'checklist read-only';
  }
  return '';
}

async function completeEvaluationChecklist(page) {
  await expect(page.getByText(/Evaluation Checklist|EVALUATION/i).first()).toBeVisible({ timeout: 20000 });
  await dismissLatestEvalModal(page);

  const done = await isEvaluationCompleted(page);
  if (done) {
    console.log(`  Evaluation already completed (${done}) — skipping checklist`);
    return { skipped: true, submitted: false };
  }

  await expandEvaluationSections(page);

  const rows = page.locator('.eve-outer');
  const count = await rows.count();
  const strategy = pickEvaluationStrategy();
  console.log(`  Evaluation questions: ${count} (strategy: ${strategy})`);
  let notOkCount = 0;
  let okCount = 0;
  const amounts = [];
  await logSectionProgress(page, 'Sections before');
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await ensureRowVisible(page, row))) {
      console.log(`  Question ${i + 1} is still hidden; skipped.`);
      continue;
    }
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const wantNotOk = strategy === 'all-not-ok' || (strategy === 'mixed' && Math.random() < 0.5);
    const { selected, isNotOk } = await selectOkOrNotOk(row, wantNotOk);
    if (!selected) {
      await answerInputQuestion(row);
    } else if (isNotOk) {
      notOkCount += 1;
    } else {
      okCount += 1;
    }
    // Sub-options / remarks can be required on any option, including OK.
    await page.waitForTimeout(150);
    const { cost } = await fillQuestionDependents(row, isNotOk);
    if (cost) amounts.push(Number(cost));
  }
  console.log(`  Answered ${count} questions (OK: ${okCount}, Not OK: ${notOkCount})`);
  await logSectionProgress(page, 'Sections after');
  if (amounts.length) {
    const total = amounts.reduce((sum, value) => sum + value, 0);
    console.log(`  Random Est. Ref. Exp on ${amounts.length}/${count} questions, total ₹${total.toLocaleString('en-IN')}`);
  }

  let saved = await submitChecklist(page);
  for (let attempt = 0; !saved && attempt < 2; attempt++) {
    if (!(await fixFlaggedQuestions(page))) break;
    saved = await submitChecklist(page);
  }
  console.log(saved
    ? '  Evaluation checklist submitted'
    : '  Evaluation checklist submit did not confirm — check required fields');
  return { skipped: false, submitted: saved };
}

function imageCards(page) {
  return page.locator('.card').filter({ has: page.locator('input[type="file"]') });
}

async function cardHasUploadedImage(card) {
  const src = await card.locator('img').first().getAttribute('src').catch(() => '');
  return Boolean(src) && !src.startsWith('blob:') && !/placeholder|image-thumbs/i.test(src);
}

/**
 * Identify the upload without depending on the API host/path, which comes from
 * g.$base_url_api and differs per environment.
 *
 * postData() alone is not enough: Chromium does not hand back the body of a
 * multipart request carrying a file, so it returns null and no event is ever
 * recorded. That made every card time out and upload a second time. The
 * multipart content-type is always present, so use it as the primary signal.
 */
function isUploadRequest(request) {
  if (request.method() !== 'POST') return false;
  const type = request.headers()['content-type'] || '';
  if (/multipart\/form-data/i.test(type)) return true;
  let post = '';
  try {
    post = request.postData() || '';
  } catch {
    post = '';
  }
  return /uploadimages/i.test(post);
}

function watchUploadResponses(page) {
  const events = [];
  const handler = async (response) => {
    if (!isUploadRequest(response.request())) return;
    const body = await response.json().catch(() => null);
    events.push({
      ok: response.status() === 200 && body?.status === 'ok',
      status: response.status(),
      msg: body?.msg || '',
    });
  };
  page.on('response', handler);
  return { events, dispose: () => page.off('response', handler) };
}

/**
 * stage.ucdms.in sits behind a rate limiter (nothing in the app returns 429),
 * and it blocks for minutes once tripped. Upload sequentially, pace the
 * requests, and back off instead of hammering.
 */
const UPLOAD_DELAY_MS = Number(process.env.DMS_UPLOAD_DELAY_MS ?? 1200);
const RATE_LIMIT_WAIT_MS = Number(process.env.DMS_RATE_LIMIT_WAIT_MS ?? 60000);

function watchRateLimit(page) {
  const state = { hits: 0, handled: 0 };
  const handler = (response) => {
    if (response.status() === 429) state.hits += 1;
  };
  page.on('response', handler);
  return { state, dispose: () => page.off('response', handler) };
}

async function backOffIfRateLimited(page, limiter) {
  if (limiter.state.hits <= limiter.state.handled) return false;
  limiter.state.handled = limiter.state.hits;
  console.log(`  Rate limited (HTTP 429) — pausing ${Math.round(RATE_LIMIT_WAIT_MS / 1000)}s before continuing`);
  await page.waitForTimeout(RATE_LIMIT_WAIT_MS);
  return true;
}

/**
 * The card animates on hover and the UPLOAD button sits under a blurred
 * overlay, so a normal click can be refused. A DOM click still fires the
 * component's @click.stop="enqueueUpload(key)", and costs nothing.
 */
async function clickUploadButton(upload) {
  return upload.evaluate((el) => {
    el.click();
    return true;
  }).catch(() => false);
}

function uploadButton(card) {
  return card.getByRole('button', { name: /^UPLOAD$/i });
}

/**
 * images.js uploads through a queue and calls store.getDetail() after each
 * success, which rebuilds getImagesConfig and drops any file still pending on
 * another card ("Failed to update image"). So upload one card at a time and
 * wait for the refresh before touching the next one.
 */
async function waitForUploadResult(page, index, watcher, seen) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const fresh = watcher.events.slice(seen);
    const failure = fresh.find((e) => !e.ok);
    if (failure) {
      return failure.status === 429
        ? { ok: false, retry: true, reason: 'rate limited (HTTP 429)' }
        : { ok: false, retry: false, reason: `API ${failure.status}: ${failure.msg || 'upload rejected'}` };
    }
    if (fresh.some((e) => e.ok)) return { ok: true };
    if (await cardHasUploadedImage(imageCards(page).nth(index))) return { ok: true };
    await page.waitForTimeout(250);
  }
  return { ok: false, retry: true, reason: 'no upload response within 30s' };
}

async function uploadOneCard(page, index, watcher) {
  const card = imageCards(page).nth(index);
  const input = card.locator('input[type="file"]').first();
  if (!(await input.count())) return { ok: false, retry: false, reason: 'no file input' };
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await input.setInputFiles(nextVehiclePhoto());

  const upload = uploadButton(card);
  try {
    await upload.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    return { ok: false, retry: true, reason: 'UPLOAD button never appeared' };
  }

  const seen = watcher.events.length;
  if (!(await clickUploadButton(upload))) {
    return { ok: false, retry: true, reason: 'UPLOAD button could not be clicked' };
  }
  return waitForUploadResult(page, index, watcher, seen);
}

/**
 * Mandatory slots render a red asterisk in the card header
 * (v-if="group.isRequired"). Only those block the move to Purchased.
 */
async function mandatoryCards(page) {
  const cards = imageCards(page);
  const total = await cards.count();
  const targets = [];
  for (let i = 0; i < total; i++) {
    const card = cards.nth(i);
    if (!(await card.locator('.card-header .text-danger').count())) continue;
    const label = (await card.locator('.card-header').first().innerText().catch(() => ''))
      .trim().replace(/\s*\*$/, '');
    targets.push({ index: i, label: label || `slot ${i + 1}` });
  }
  return { total, targets };
}

async function listMissingMandatoryImages(page) {
  const cards = imageCards(page);
  const { total, targets } = await mandatoryCards(page);
  const missing = [];
  for (const { index, label } of targets) {
    if (!(await cardHasUploadedImage(cards.nth(index)))) missing.push(label);
  }
  return { total, required: targets.length, missing };
}

async function uploadMandatoryImages(page) {
  if (skipImagesOnLocalDms(page)) {
    console.log('  Skipping Images-tab uploads on dms.jlr.local');
    return { skipped: true, uploaded: 0, present: 0, failed: 0, missing: [], required: 0 };
  }
  const cards = imageCards(page);
  await expect(cards.first()).toBeVisible({ timeout: 20000 }).catch(() => {});

  const watcher = watchUploadResponses(page);
  const limiter = watchRateLimit(page);
  const startedAt = Date.now();
  let uploaded = 0;
  let present = 0;
  let failed = 0;
  try {
    const { total, targets } = await mandatoryCards(page);
    console.log(`  Image slots: ${total}, mandatory: ${targets.length}`);

    for (const { index, label } of targets) {
      if (await cardHasUploadedImage(cards.nth(index))) {
        present += 1;
        continue;
      }
      await backOffIfRateLimited(page, limiter);

      let result = await uploadOneCard(page, index, watcher);
      if (!result.ok && result.retry) {
        await backOffIfRateLimited(page, limiter);
        result = await uploadOneCard(page, index, watcher);
      }
      if (result.ok) {
        uploaded += 1;
      } else {
        failed += 1;
        console.log(`  Upload failed: ${label} — ${result.reason}`);
      }
      // Pace the next one: every upload also triggers a getDetail refresh.
      if (UPLOAD_DELAY_MS > 0) await page.waitForTimeout(UPLOAD_DELAY_MS);
    }

    const secs = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  Mandatory images: ${uploaded} uploaded, ${present} already present${failed ? `, ${failed} failed` : ''} in ${secs}s`);
    if (limiter.state.hits) {
      console.log(`  Note: hit HTTP 429 ${limiter.state.hits} time(s) — raise DMS_UPLOAD_DELAY_MS if this repeats`);
    }
  } finally {
    watcher.dispose();
    limiter.dispose();
  }

  const after = await listMissingMandatoryImages(page);
  if (after.missing.length) {
    console.log(`  Mandatory images still missing (${after.missing.length}/${after.required}): ${after.missing.join(', ')}`);
  }
  return {
    skipped: false,
    uploaded,
    present,
    failed,
    missing: after.missing,
    required: after.required,
  };
}

/**
 * Purchased is refused unless all required Images-tab photos (22 named shots)
 * are in sellleads_images. Upload any that are still empty, then return to STATUS.
 */
async function ensureMandatoryImagesForPurchase(page) {
  console.log('→ Purchase Master: check mandatory IMAGES before Purchased');
  if (skipImagesOnLocalDms(page)) {
    console.log('  dms.jlr.local cannot save Images-tab photos; Purchased will be refused');
    return { ready: false, skipped: true, missing: ['Images-tab uploads skipped on dms.jlr.local'] };
  }

  await openDetailTab(page, 'IMAGES');
  await expect(imageCards(page).first()).toBeVisible({ timeout: 20000 }).catch(() => {});
  const before = await listMissingMandatoryImages(page);
  console.log(`  Mandatory image slots: ${before.required}${before.missing.length ? `, missing ${before.missing.length}` : ', all present'}`);

  if (before.required === 0) {
    console.log('  No mandatory image cards found on IMAGES — Purchased will be refused');
    await openDetailTab(page, 'STATUS');
    return { ready: false, missing: ['no mandatory image cards rendered'] };
  }

  if (!before.missing.length) {
    await openDetailTab(page, 'STATUS');
    return { ready: true, missing: [] };
  }

  console.log(`  Uploading ${before.missing.length} missing mandatory photo(s) before Purchased`);
  const result = await uploadMandatoryImages(page);
  await openDetailTab(page, 'STATUS');
  return { ready: !result.missing.length, missing: result.missing };
}

async function runStatusEvaluationAndImages(page) {
  console.log('→ Purchase Master: open STATUS and update the lead');
  await openDetailTab(page, 'STATUS');
  const current = (await currentSelectLabel(page, 'status')) || '';
  console.log(`  Current Status of Lead: ${current || '(empty)'}`);

  if (/purchas/i.test(current)) {
    console.log('  Status of Lead is already Purchased');
    return { inEvaluation: false, finalStatus: 'Purchased' };
  }
  if (/lost/i.test(current)) {
    console.log('  Status of Lead is Lost — final status, stopping');
    return { inEvaluation: false, finalStatus: current };
  }

  let inEvaluation = false;
  let evaluation = { skipped: true, submitted: false };

  if (/deal\s*done/i.test(current)) {
    console.log('  Lead is already Deal Done — skip Evaluation, then Purchased');
  } else {
    inEvaluation = await updateStatusToEvaluation(page);
    if (!inEvaluation) {
      console.log('  Lead is not in Evaluation / Follow up — skipping Evaluation tab, still walking status');
    } else {
      console.log('→ Purchase Master: EVALUATION (only when not already completed)');
      await openDetailTab(page, 'EVALUATION');
      evaluation = await completeEvaluationChecklist(page);
      if (!(evaluation.skipped || evaluation.submitted)) {
        console.log('  Evaluation not confirmed — leaving the lead status unchanged');
        return { inEvaluation: true, evaluationSkipped: false, finalStatus: '' };
      }
    }
  }

  const imagesSkipped = skipImagesOnLocalDms(page);
  if (imagesSkipped) {
    console.log('→ Purchase Master: skip IMAGES on dms.jlr.local');
  } else {
    console.log('→ Purchase Master: upload mandatory IMAGES');
    await openDetailTab(page, 'IMAGES');
    await uploadMandatoryImages(page);
  }

  const finalStatus = await advanceLeadStatusToPurchased(page);
  return {
    inEvaluation,
    evaluationSkipped: evaluation.skipped,
    imagesSkipped: skipImagesOnLocalDms(page),
    finalStatus,
  };
}

module.exports = {
  openDetailTab,
  updateStatusToEvaluation,
  isEvaluationCompleted,
  completeEvaluationChecklist,
  dismissLatestEvalModal,
  advanceLeadStatusToPurchased,
  uploadMandatoryImages,
  runStatusEvaluationAndImages,
  skipImagesOnLocalDms,
  expandEvaluationSections,
  ensureRowVisible,
  logSectionProgress,
  fillRandomRefurbCost,
  dummyImagePath,
};
