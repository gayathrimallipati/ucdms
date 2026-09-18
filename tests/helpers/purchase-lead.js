const { expect } = require('@playwright/test');
const {
  selectSearchOption,
  selectIfVisible,
  fillIfVisible,
  selectWrapper,
  dismissAppModals,
  pickDateIfVisible,
  fillPinCodeSearch,
  checkFirstIfVisible,
  isVisible,
  tryVaahanFetch,
  noteVerifyAddons,
  fillRemainingCustomFields,
  waitForRealOptions,
  selectColorAfterMake,
  fillJlrChassis,
  currentSelectLabel,
  isSelectUnset,
  randomInt,
} = require('./form');
const { saveFailedLoginShot, toast } = require('./login');

function uniqueMobile() {
  return `9${Date.now().toString().slice(-9)}`;
}

function normalizeLeadId(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { raw: '', digits: '', formatted: '', search: '' };
  const digits = trimmed.replace(/^PM/i, '').replace(/\D/g, '');
  const formatted = digits ? `PM${digits}` : trimmed.toUpperCase();
  return { raw: trimmed, digits, formatted, search: formatted };
}

async function waitForCustomComponents(page) {
  await expect(selectWrapper(page, 'source')).toBeVisible({ timeout: 20000 });
  await expect(selectWrapper(page, 'source_sub')).toBeVisible();
  await expect(selectWrapper(page, 'branch')).toBeVisible();
  await expect(selectWrapper(page, 'executive')).toBeVisible();
  await expect(selectWrapper(page, 'title')).toBeVisible();
  await expect(selectWrapper(page, 'reason_for_selling')).toBeVisible();
  await expect(page.locator('#first_name')).toBeVisible();
  await expect(page.locator('#last_name')).toBeVisible();
  await expect(page.locator('#mobile')).toBeVisible();

  await noteVerifyAddons(page);
  const datePickers = page.locator('form .dtp-wrapper');
  const selects = page.locator('form .selectsearch-wrapper');
  console.log(`  custom SelectSearch on form: ${await selects.count()}`);
  console.log(`  custom DateTimePicker on form: ${await datePickers.count()} (more appear after Registration Type)`);
  console.log(`  custom Vaahan on form: ${(await page.locator('button[title="Fetch Vahan Data"]').count()) > 0 ? 'yes' : 'not shown yet'}`);
  console.log('  waiting for Source / Branch master lists (getCollections)…');
  await waitForRealOptions(page, 'source');
  await waitForRealOptions(page, 'branch');
}

async function collectVisibleLeads(page) {
  return page.evaluate(() => {
    const items = [];
    const seen = new Set();
    document.querySelectorAll('table tbody tr, .mobilecard').forEach((el) => {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const match = text.match(/Lead ID\s*:?\s*(PM\d+)/i);
      if (!match) return;
      const id = match[1].toUpperCase();
      if (seen.has(id)) return;
      seen.add(id);
      items.push({ id, summary: text.slice(0, 180) });
    });
    return items;
  });
}

async function collectVisibleLeadIds(page) {
  return (await collectVisibleLeads(page)).map((lead) => lead.id);
}

async function pickDependentSelect(page, fieldId, opts = {}) {
  if (!(await isVisible(selectWrapper(page, fieldId)))) return null;
  if (!(await isSelectUnset(page, fieldId))) return null;
  return selectIfVisible(page, fieldId, { onlyIfEmpty: true, ...opts });
}

async function fillReasonExtras(page) {
  // Only selling (5) shows #rs_subsection. Buying a car (1–4) shows make/model/horizon/budget.
  // Do not require #rs_make — that field is hidden for Only selling.
  await Promise.race([
    selectWrapper(page, 'rs_subsection').waitFor({ state: 'visible', timeout: 5000 }),
    selectWrapper(page, 'rs_make').waitFor({ state: 'visible', timeout: 5000 }),
  ]).catch(() => {});

  const subsection = await pickDependentSelect(page, 'rs_subsection');
  if (subsection) console.log(`  Reason (depends on Reason for Selling): ${subsection}`);

  const make = await pickDependentSelect(page, 'rs_make', { waitFor: 'rs_model' });
  if (make) console.log(`  Make (Interested): ${make}`);
  const model = await pickDependentSelect(page, 'rs_model', { waitFor: 'rs_variant' });
  if (model) console.log(`  Model (Interested): ${model}`);
  const variant = await pickDependentSelect(page, 'rs_variant');
  if (variant) console.log(`  Variant (Interested): ${variant}`);
  const horizon = await pickDependentSelect(page, 'buying_horizon');
  if (horizon) console.log(`  Buying Horizon: ${horizon}`);
  const budget = await pickDependentSelect(page, 'budget');
  if (budget) console.log(`  Budget: ${budget}`);

  await fillIfVisible(page, 'rs_reason', 'Need a different car', { onlyIfEmpty: true });
}

async function fillVisibleDependents(page, { stamp } = {}) {
  const suffix = stamp || Date.now().toString().slice(-6);
  console.log('→ Purchase Master: fill dependent fields that are now visible');

  const sub = await pickDependentSelect(page, 'source_sub');
  if (sub) console.log(`  Sub Source (depends on Source): ${sub}`);

  const exec = await pickDependentSelect(page, 'executive');
  if (exec) console.log(`  Executive (depends on Branch): ${exec}`);

  const wps = selectWrapper(page, 'wps_executive');
  if (await isVisible(wps) && await isSelectUnset(page, 'wps_executive')) {
    await waitForRealOptions(page, 'wps_executive', 15000).catch(async () => {
      console.log('  WPS list empty — re-selecting Branch so getWpsExecutives runs');
      await selectIfVisible(page, 'branch', { waitFor: ['executive', 'wps_executive'] });
    });
    const picked = await selectIfVisible(page, 'wps_executive', { onlyIfEmpty: true });
    console.log(`  Workshop Product Specialist (depends on Source + Branch): ${picked || '(none)'}`);
  }

  await fillIfVisible(page, 'referred_by', `Referee${suffix}`, { onlyIfEmpty: true });
  await fillIfVisible(page, 'referee_job_role', 'Advisor', { onlyIfEmpty: true });

  const title = await currentSelectLabel(page, 'title');
  if (/m\s*\/\s*s/i.test(title || '')) {
    const company = page.locator('#contact_name');
    await expect(company).toBeVisible({ timeout: 10000 });
    const existing = await company.inputValue().catch(() => '');
    if (!String(existing).trim()) {
      await fillIfVisible(page, 'contact_name', `TestCo${suffix}`);
      console.log('  Company Name (depends on Salutation M/s)');
    }
  }

  const regType = await currentSelectLabel(page, 'reg_type');
  if (/company/i.test(regType || '')) {
    await expect(page.locator('#contact_name')).toBeVisible({ timeout: 8000 }).catch(() => {});
    await fillIfVisible(page, 'contact_name', `TestCo${suffix}`, { onlyIfEmpty: true });
  }

  const model = await pickDependentSelect(page, 'model', { waitFor: 'variant' });
  if (model) console.log(`  Model (depends on Make): ${model}`);
  const variant = await pickDependentSelect(page, 'variant');
  if (variant) console.log(`  Variant (depends on Model): ${variant}`);
  if (await isVisible(selectWrapper(page, 'color')) && await isSelectUnset(page, 'color')) {
    const color = await selectColorAfterMake(page, 'color');
    if (color) console.log(`  Exterior Color (depends on Make): ${color}`);
  }
  if (await isVisible(selectWrapper(page, 'interior_color')) && await isSelectUnset(page, 'interior_color')) {
    const interior = await selectColorAfterMake(page, 'interior_color').catch(() => null);
    if (interior) console.log(`  Interior Color (depends on JLR Make): ${interior}`);
  }

  const park = await pickDependentSelect(page, 'park_and_sell');
  if (park) console.log(`  Park and Sell (depends on Vehicle Source): ${park}`);

  const hypo = await currentSelectLabel(page, 'hypothecation');
  if (/^yes$/i.test(hypo || '')) {
    await fillIfVisible(page, 'bank_name', 'Test Bank', { onlyIfEmpty: true });
    console.log('  Bank Name (depends on Hypothecation Yes)');
  }

  const subStatus = await pickDependentSelect(page, 'sub_status');
  if (subStatus) console.log(`  Sub Status (depends on Status): ${subStatus}`);
  await pickDateIfVisible(page, 'followup_date');

  await fillReasonExtras(page);
}

async function fillAllLeadDetails(page, { stamp, keepExistingCustomer = false } = {}) {
  const suffix = stamp || Date.now().toString().slice(-6);

  await selectIfVisible(page, 'source', { onlyIfEmpty: keepExistingCustomer, waitFor: ['source_sub', 'wps_executive'] });
  await selectIfVisible(page, 'source_sub', { onlyIfEmpty: keepExistingCustomer });
  await selectIfVisible(page, 'branch', { onlyIfEmpty: keepExistingCustomer, waitFor: ['executive', 'wps_executive'] });
  await selectIfVisible(page, 'executive', { onlyIfEmpty: keepExistingCustomer });
  await fillIfVisible(page, 'referred_by', `Referee${suffix}`, { onlyIfEmpty: true });
  await fillIfVisible(page, 'referee_job_role', 'Advisor', { onlyIfEmpty: true });
  await selectIfVisible(page, 'wps_executive', { onlyIfEmpty: true });

  await selectIfVisible(page, 'title', { onlyIfEmpty: keepExistingCustomer });
  await fillVisibleDependents(page, { stamp: suffix });

  await fillIfVisible(page, 'contact_name', `TestCo${suffix}`, { onlyIfEmpty: true });
  await fillIfVisible(page, 'first_name', `Test${suffix}`, { onlyIfEmpty: keepExistingCustomer });
  await fillIfVisible(page, 'last_name', `Lead${suffix}`, { onlyIfEmpty: keepExistingCustomer });
  await fillIfVisible(page, 'mobile', uniqueMobile(), { onlyIfEmpty: keepExistingCustomer });
  await fillIfVisible(page, 'email', `pm.lead.${suffix}@example.com`, { onlyIfEmpty: true });
  await checkFirstIfVisible(page, 'contact_method');
  await fillPinCodeSearch(page, 'pin_code');
  await fillIfVisible(page, 'address', `12 Test Street ${suffix}`);
  await fillIfVisible(page, 'customer_notes', `Full lead details filled by automation ${suffix}`);
  await selectIfVisible(page, 'reason_for_selling', { onlyIfEmpty: keepExistingCustomer });
  await fillReasonExtras(page);
  await fillIfVisible(page, 'alternate_contact_name', `Alt${suffix}`, { onlyIfEmpty: true });
  await fillIfVisible(page, 'alternate_contact_mobile', uniqueMobile(), { onlyIfEmpty: true });
  await selectIfVisible(page, 'relationship_to_primary', { onlyIfEmpty: true });

  console.log('→ Purchase Master: fill vehicle details');
  const vehicleSource = await selectIfVisible(page, 'source_other');
  console.log(`  Vehicle Source: ${vehicleSource || '(hidden)'}`);
  await selectIfVisible(page, 'park_and_sell', { onlyIfEmpty: true });

  const regType = await selectIfVisible(page, 'reg_type', { exclude: [/unregistered/i] });
  console.log(`  Registration Type: ${regType || '(hidden)'}`);
  if (regType) {
    await expect(selectWrapper(page, 'make')).toBeVisible({ timeout: 15000 });
    await waitForRealOptions(page, 'make');
  }

  await fillIfVisible(page, 'reg_num', `MH12AB${suffix.slice(-4)}`);
  await tryVaahanFetch(page);
  if (await pickDateIfVisible(page, 'reg_date')) console.log('  Registration Date: DateTimePicker');

  await selectIfVisible(page, 'mfg_year');
  await selectIfVisible(page, 'mfg_month');

  const jlrMakes = ['Jaguar', 'Land Rover'];
  const preferredMake = process.env.DMS_MAKE || jlrMakes[randomInt(jlrMakes.length)];
  let make = '';
  if (await isVisible(selectWrapper(page, 'make'))) {
    make = await selectIfVisible(page, 'make', {
      search: preferredMake,
      label: preferredMake,
      waitFor: ['model', 'color'],
    })
      || await selectIfVisible(page, 'make', {
        search: preferredMake === 'Jaguar' ? 'Land Rover' : 'Jaguar',
        waitFor: ['model', 'color'],
      })
      || await selectSearchOption(page, 'make', { waitFor: ['model', 'color'] });
    console.log(`  Make: ${make}`);
  }
  if (await isVisible(selectWrapper(page, 'model'))) {
    await waitForRealOptions(page, 'model');
    const model = await selectSearchOption(page, 'model', { waitFor: 'variant' });
    console.log(`  Model: ${model}`);
  }
  if (await isVisible(selectWrapper(page, 'variant'))) {
    await waitForRealOptions(page, 'variant');
    const variant = await selectSearchOption(page, 'variant');
    console.log(`  Variant: ${variant}`);
  }
  const color = await selectColorAfterMake(page, 'color');
  console.log(`  Exterior Color: ${color || '(empty after make)'}`);
  const interior = await selectColorAfterMake(page, 'interior_color').catch(() => null);
  if (interior) console.log(`  Interior Color: ${interior}`);
  await selectIfVisible(page, 'body_type');
  await selectIfVisible(page, 'transmission');
  await fillIfVisible(page, 'mileage', String(8000 + randomInt(40000)));
  await selectIfVisible(page, 'fuel');
  await selectIfVisible(page, 'fuel_end');
  await selectIfVisible(page, 'owners');
  await selectIfVisible(page, 'hypothecation');
  await fillIfVisible(page, 'bank_name', 'Test Bank');
  await selectIfVisible(page, 'loan_paid_off');
  await fillIfVisible(page, 'loan_amount', '150000');
  await selectIfVisible(page, 'insurance_type');
  if (await pickDateIfVisible(page, 'insurance_exp_date')) console.log('  Insurance expiry: picked');
  if (await pickDateIfVisible(page, 'third_party_insurance_exp_date')) console.log('  Third-party expiry: picked');
  await fillPinCodeSearch(page, 'rc_pin_code');
  await fillIfVisible(page, 'rc_address', `RC Address ${suffix}`);

  await fillVisibleDependents(page, { stamp: suffix });
  console.log('→ Purchase Master: fill any leftover custom SelectSearch / pin_code_search / DateTimePicker');
  await fillRemainingCustomFields(page);
  await noteVerifyAddons(page);
  // Chassis last: Vue :value re-renders after MMV / leftover selects wipe an earlier fill,
  // and getJlrVin used to leave it empty instead of failing.
  await fillJlrChassis(page, make);
}

async function submitLeadForm(page, testInfo, shotName, { expectUpdate = false } = {}) {
  await dismissAppModals(page);
  const submit = page.locator('form').getByRole('button', { name: /Submit/i }).last();
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeVisible({ timeout: 15000 });
  await submit.click();

  const successToast = expectUpdate
    ? /Updated successfully|successfully/i
    : /Added successfully|Updated successfully|successfully/i;

  try {
    await Promise.race([
      page.waitForURL((url) => /\/purchase-master\/detail\/[^/]+/.test(url.pathname) && !url.pathname.endsWith('/detail'), { timeout: 25000 }),
      toast(page).filter({ hasText: successToast }).waitFor({ timeout: 25000 }),
    ]);
  } catch (err) {
    await saveFailedLoginShot(page, testInfo, shotName);
    const fieldError = page.locator('.invalid-feedback, .alert-danger').first();
    const errText = await fieldError.textContent().catch(() => '');
    throw new Error(`Could not save Purchase Master lead. ${errText || err.message}`);
  }

  await expect(page).toHaveURL(/\/purchase-master\/detail\/[^/]+/, { timeout: 20000 });
  expect(page.url()).not.toMatch(/\/purchase-master\/detail\/?$/);
}

async function openAddLeadForm(page) {
  await dismissAppModals(page);
  await page.goto('/purchase-master', { waitUntil: 'networkidle' });
  await dismissAppModals(page);
  const addBtn = page.getByRole('button', { name: /Add Purchase Lead/i });
  await expect(addBtn).toBeVisible({ timeout: 20000 });
  await addBtn.click();
  await expect(page).toHaveURL(/\/purchase-master\/detail\/?$/, { timeout: 20000 });
  await expect(page.getByText('Lead Details')).toBeVisible({ timeout: 20000 });
  await dismissAppModals(page);
}

async function createPurchaseLead(page, testInfo) {
  console.log('\n→ Purchase Master: open add-lead form');
  await openAddLeadForm(page);

  console.log('→ Purchase Master: check custom SelectSearch / Verify / DateTimePicker / Vaahan');
  await waitForCustomComponents(page);

  const stamp = Date.now().toString().slice(-6);
  console.log('→ Purchase Master: fill all visible custom-component fields');
  await fillAllLeadDetails(page, { stamp, keepExistingCustomer: false });

  console.log('→ Purchase Master: submit lead');
  await submitLeadForm(page, testInfo, 'purchase-lead-create-failed');
  const fromPage = (await page.locator('body').innerText()).match(/\bPM\d+\b/);
  let leadId = fromPage ? fromPage[0] : '';
  if (!leadId) {
    await page.goto('/purchase-master', { waitUntil: 'networkidle' });
    await dismissAppModals(page);
    const ids = await collectVisibleLeadIds(page);
    leadId = ids[0] || '';
  }
  if (leadId) console.log(`  Created Lead ID: ${leadId}`);
  console.log(`  Lead created → ${page.url()}`);
  return { url: page.url(), leadId };
}

module.exports = {
  createPurchaseLead,
  openAddLeadForm,
  waitForCustomComponents,
  normalizeLeadId,
  collectVisibleLeads,
  collectVisibleLeadIds,
  submitLeadForm,
  fillAllLeadDetails,
  fillVisibleDependents,
};
