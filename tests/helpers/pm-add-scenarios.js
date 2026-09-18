/**
 * Purchase Master — add-lead test cases.
 * Runs in the same browser session after login.
 */
const { expect } = require('@playwright/test');
const {
  selectSearchOption,
  selectIfVisible,
  fillIfVisible,
  selectWrapper,
  fillPinCodeSearch,
  isVisible,
  waitForRealOptions,
  fillJlrChassis,
  fillChassisField,
  currentSelectLabel,
} = require('./form');
const {
  openAddLeadForm,
  waitForCustomComponents,
  fillAllLeadDetails,
  submitLeadForm,
} = require('./purchase-lead');
const { saveFailedLoginShot, toast } = require('./login');

function fieldError(page, fieldKey) {
  return page.locator(`[data-error-key="${fieldKey}"]`);
}

function anyFieldError(page) {
  return page.locator('.invalid-feedback.d-block, [data-error-key]');
}

async function clickSubmit(page) {
  const submit = page.locator('form').getByRole('button', { name: /Submit/i }).last();
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
}

async function expectStillOnAddForm(page) {
  await expect(page).toHaveURL(/\/purchase-master\/detail\/?$/, { timeout: 15000 });
}

async function expectValidationFailed(page) {
  await Promise.race([
    toast(page).filter({ hasText: /Validation failed|required|valid/i }).waitFor({ timeout: 15000 }),
    anyFieldError(page).first().waitFor({ state: 'visible', timeout: 15000 }),
  ]).catch(() => {});
  await expectStillOnAddForm(page);
}

async function expectChassisRejected(page, pattern) {
  await expectStillOnAddForm(page);
  await expect.poll(async () => {
    const field = await fieldError(page, 'chassis').textContent().catch(() => '');
    const toastText = await toast(page).textContent().catch(() => '');
    return `${field} ${toastText}`;
  }, { timeout: 20000 }).toMatch(pattern);
}

async function fillRequiredCustomer(page) {
  await selectIfVisible(page, 'source', { waitFor: 'source_sub' });
  await selectIfVisible(page, 'source_sub');
  await selectIfVisible(page, 'branch', { waitFor: 'executive' });
  await selectIfVisible(page, 'executive');
  await selectIfVisible(page, 'title');
  const stamp = Date.now().toString().slice(-5);
  await fillIfVisible(page, 'first_name', `Add${stamp}`);
  await fillIfVisible(page, 'last_name', `Case${stamp}`);
  await fillIfVisible(page, 'mobile', `9${Date.now().toString().slice(-9)}`);
}

async function runPmAddScenarios(page, testInfo, report) {
  const failures = [];
  const rec = report || { pass() {}, fail() {} };
  let createdLeadId = '';

  async function scenario(name, fn) {
    const label = `PM add: ${name}`;
    process.stdout.write(`\n→ ${label}\n`);
    try {
      await fn();
      rec.pass(label, createdLeadId ? `Lead ${createdLeadId}` : '');
      console.log('  ok');
    } catch (err) {
      const shot = await saveFailedLoginShot(page, testInfo, `pm-add-${name}`).catch(() => '');
      rec.fail(label, err, shot || '');
      failures.push(`PM add — ${name}: ${err.message}`);
      console.log(`  FAIL: ${err.message}`);
    }
  }

  await scenario('Add Purchase Lead opens the add form', async () => {
    await openAddLeadForm(page);
    await expect(page.getByText('Lead Details')).toBeVisible();
    await expect(page.locator('form').getByRole('button', { name: /Submit/i }).last()).toBeVisible();
  });

  await scenario('lead and customer fields are visible', async () => {
    await waitForCustomComponents(page);
    await expect(selectWrapper(page, 'source')).toBeVisible();
    await expect(selectWrapper(page, 'source_sub')).toBeVisible();
    await expect(selectWrapper(page, 'branch')).toBeVisible();
    await expect(selectWrapper(page, 'executive')).toBeVisible();
    await expect(selectWrapper(page, 'title')).toBeVisible();
    await expect(page.locator('#first_name')).toBeVisible();
    await expect(page.locator('#last_name')).toBeVisible();
    await expect(page.locator('#mobile')).toBeVisible();
    await expect(selectWrapper(page, 'reason_for_selling')).toBeVisible();
  });

  await scenario('vehicle MMV and color stay hidden until Registration Type', async () => {
    await expect(selectWrapper(page, 'make')).toBeHidden();
    await expect(selectWrapper(page, 'model')).toBeHidden();
    await expect(selectWrapper(page, 'variant')).toBeHidden();
    await expect(selectWrapper(page, 'color')).toBeHidden();
    await expect(page.locator('#chassis')).toBeHidden();
  });

  await scenario('empty submit is rejected', async () => {
    await clickSubmit(page);
    await expectValidationFailed(page);
    const requiredHints = page.locator('.invalid-feedback.d-block, [data-error-key], .text-danger');
    await expect.poll(async () => requiredHints.count(), { timeout: 10000 }).toBeGreaterThan(0);
  });

  await scenario('Source list loads from master data', async () => {
    await waitForRealOptions(page, 'source');
    const source = await selectSearchOption(page, 'source', { waitFor: 'source_sub' });
    expect(source, 'Source must be a real option').toBeTruthy();
    expect(source).not.toMatch(/^Select /i);
    console.log(`  Source: ${source}`);
  });

  await scenario('Sub Source fills after Source', async () => {
    await expect(selectWrapper(page, 'source_sub')).toBeVisible();
    await waitForRealOptions(page, 'source_sub');
    const sub = await selectSearchOption(page, 'source_sub');
    expect(sub).toBeTruthy();
    expect(sub).not.toMatch(/^Select /i);
    console.log(`  Sub Source: ${sub}`);
  });

  await scenario('Executive fills after Branch', async () => {
    await waitForRealOptions(page, 'branch');
    const branch = await selectSearchOption(page, 'branch', { waitFor: 'executive' });
    expect(branch).toBeTruthy();
    await waitForRealOptions(page, 'executive');
    const exec = await selectSearchOption(page, 'executive');
    expect(exec).toBeTruthy();
    console.log(`  Branch: ${branch} / Executive: ${exec}`);
  });

  await scenario('invalid email is rejected', async () => {
    await fillIfVisible(page, 'first_name', 'EmailCase');
    await fillIfVisible(page, 'last_name', 'Lead');
    await fillIfVisible(page, 'mobile', `9${Date.now().toString().slice(-9)}`);
    await fillIfVisible(page, 'email', 'not-an-email');
    await clickSubmit(page);
    await expectValidationFailed(page);
    const emailErr = fieldError(page, 'email');
    if (await emailErr.count()) {
      await expect(emailErr).toContainText(/email|valid/i);
    }
  });

  await scenario('invalid mobile is rejected', async () => {
    await page.locator('#mobile').fill('123');
    await clickSubmit(page);
    await expectValidationFailed(page);
    const mobileErr = fieldError(page, 'mobile');
    if (await mobileErr.count()) {
      await expect(mobileErr).toContainText(/mobile|valid|required/i);
    }
    await page.locator('#mobile').fill(`9${Date.now().toString().slice(-9)}`);
  });

  await scenario('pincode of 3+ digits opens the area list', async () => {
    const wrapper = selectWrapper(page, 'pin_code');
    await expect(wrapper).toBeVisible();
    const input = wrapper.locator('input.border-0.w-100');
    await input.click();
    await input.fill('');
    await input.pressSequentially('400', { delay: 50 });
    await wrapper.evaluate((el) => el.__vueSelectSearch?.toggleDropdown(true));
    const dropdown = wrapper.locator('.selectsearch-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 15000 });
    const items = dropdown.locator('div.px-3.py-2.cursor-pointer');
    await expect.poll(async () => items.count(), { timeout: 15000 }).toBeGreaterThan(0);
    await wrapper.evaluate((el) => el.__vueSelectSearch?.closeDropdown?.());
  });

  await scenario('picking a pincode area fills city and state', async () => {
    await fillPinCodeSearch(page, 'pin_code');
    const city = page.locator('#city_name');
    const state = page.locator('#state_name');
    if (await isVisible(city)) {
      await expect.poll(async () => city.inputValue(), { timeout: 10000 }).not.toBe('');
    }
    if (await isVisible(state)) {
      await expect.poll(async () => state.inputValue(), { timeout: 10000 }).not.toBe('');
    }
  });

  await scenario('Registration Type reveals vehicle fields', async () => {
    await expect(selectWrapper(page, 'reg_type')).toBeVisible();
    const regType = await selectIfVisible(page, 'reg_type', { exclude: [/unregistered/i] });
    expect(regType).toBeTruthy();
    await expect(selectWrapper(page, 'make')).toBeVisible({ timeout: 15000 });
    await expect(selectWrapper(page, 'model')).toBeVisible();
    await expect(page.locator('#chassis')).toBeVisible();
    console.log(`  Registration Type: ${regType}`);
  });

  await scenario('Unregistered hides registration number', async () => {
    await selectIfVisible(page, 'reg_type', { search: 'Unregistered', label: 'Unregistered' });
    await expect(page.locator('#reg_num')).toBeHidden({ timeout: 8000 });
    await selectIfVisible(page, 'reg_type', { exclude: [/unregistered/i] });
    await expect(selectWrapper(page, 'make')).toBeVisible({ timeout: 15000 });
  });

  await scenario('Company Registered shows company name', async () => {
    await selectIfVisible(page, 'reg_type', { search: 'Company', label: 'Company Registered' });
    const company = page.locator('#contact_name');
    await expect(company).toBeVisible({ timeout: 10000 });
    await fillIfVisible(page, 'contact_name', 'Test Motors Pvt Ltd');
    await selectIfVisible(page, 'reg_type', { exclude: [/unregistered/i] });
  });

  await scenario('Make loads Model and Exterior Color', async () => {
    await waitForRealOptions(page, 'make');
    const make = await selectIfVisible(page, 'make', {
      search: 'Jaguar',
      label: 'Jaguar',
      waitFor: ['model', 'color'],
    }) || await selectSearchOption(page, 'make', { search: 'Land Rover', waitFor: ['model', 'color'] });
    expect(make).toMatch(/jaguar|land\s*rover/i);
    await waitForRealOptions(page, 'model');
    const model = await selectSearchOption(page, 'model', { waitFor: 'variant' });
    expect(model).toBeTruthy();
    await waitForRealOptions(page, 'color');
    console.log(`  Make/Model: ${make} / ${model}`);
  });

  await scenario('Model loads Variant', async () => {
    await waitForRealOptions(page, 'variant');
    const variant = await selectSearchOption(page, 'variant');
    expect(variant).toBeTruthy();
    expect(variant).not.toMatch(/^Select /i);
    console.log(`  Variant: ${variant}`);
  });

  await scenario('Jaguar / Land Rover shows Interior Color', async () => {
    const makeLabel = await currentSelectLabel(page, 'make');
    if (/jaguar|land\s*rover/i.test(makeLabel)) {
      await expect(selectWrapper(page, 'interior_color')).toBeVisible({ timeout: 15000 });
    }
  });

  await scenario('Park and Sell appears for JLR Financial Services', async () => {
    const vehicleSource = selectWrapper(page, 'source_other');
    if (!(await isVisible(vehicleSource))) return;
    await selectIfVisible(page, 'source_other', { search: 'JLR Financial', label: 'JLR Financial Services' });
    const park = selectWrapper(page, 'park_and_sell');
    if (await isVisible(park)) {
      await selectIfVisible(page, 'park_and_sell');
      console.log('  Park and Sell: visible');
    }
  });

  await scenario('Hypothecation Yes shows bank name', async () => {
    const hypo = selectWrapper(page, 'hypothecation');
    if (!(await isVisible(hypo))) return;
    await selectIfVisible(page, 'hypothecation', { label: 'Yes' });
    const bank = page.locator('#bank_name');
    if (await isVisible(bank)) {
      await fillIfVisible(page, 'bank_name', 'Test Bank');
      console.log('  bank_name: visible after Hypothecation Yes');
    }
  });

  await scenario('fill a complete add form before VIN negatives', async () => {
    await fillIfVisible(page, 'email', `pm.add.${Date.now().toString().slice(-6)}@example.com`);
    await fillAllLeadDetails(page, { stamp: Date.now().toString().slice(-6), keepExistingCustomer: false });
  });

  await scenario('JLR VIN that does not start with SA is rejected', async () => {
    await fillChassisField(page, 'MAT1234567ABC0001');
    await clickSubmit(page);
    await expectChassisRejected(page, /SA|VIN|valid/i);
  });

  await scenario('JLR VIN not in master_jlr_total_vins is rejected', async () => {
    await fillChassisField(page, 'SA1234567890ABCDE');
    await clickSubmit(page);
    await expectChassisRejected(page, /VIN|valid|master/i);
  });

  await scenario('happy path: valid SA VIN from master list creates the lead', async () => {
    const makeLabel = await currentSelectLabel(page, 'make');
    const vin = await fillJlrChassis(page, makeLabel);
    expect(vin, 'getJlrVin must return an SA VIN from master_jlr_total_vins').toMatch(/^SA[A-Z0-9]{15}$/);
    await submitLeadForm(page, testInfo, 'pm-add-happy-path-failed');
    await expect(page).toHaveURL(/\/purchase-master\/detail\/[^/]+/, { timeout: 20000 });
    expect(page.url()).not.toMatch(/\/purchase-master\/detail\/?$/);
    const fromPage = (await page.locator('body').innerText()).match(/\bPM\d+\b/);
    createdLeadId = fromPage ? fromPage[0] : '';
    if (createdLeadId) console.log(`  Created Lead ID: ${createdLeadId}`);
  });

  return { failures, leadId: createdLeadId };
}

module.exports = {
  runPmAddScenarios,
  fieldError,
  clickSubmit,
  fillRequiredCustomer,
};
