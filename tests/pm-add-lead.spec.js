const { test } = require('@playwright/test');
const { runLoginScenarios } = require('./helpers/scenarios');

/**
 * Purchase Master add-lead cases (after login), same session as npm test:
 *
 * Form
 *  - Add Purchase Lead opens the add form
 *  - lead and customer fields are visible
 *  - vehicle MMV and color stay hidden until Registration Type
 *
 * Validation
 *  - empty submit is rejected
 *  - invalid email is rejected
 *  - invalid mobile is rejected
 *  - JLR VIN that does not start with SA is rejected
 *  - JLR VIN not in master_jlr_total_vins is rejected
 *
 * Dependents
 *  - Source list loads from master data
 *  - Sub Source fills after Source
 *  - Executive fills after Branch
 *  - pincode of 3+ digits opens the area list
 *  - picking a pincode area fills city and state
 *  - Registration Type reveals vehicle fields
 *  - Unregistered hides registration number
 *  - Company Registered shows company name
 *  - Make loads Model and Exterior Color
 *  - Model loads Variant
 *  - Jaguar / Land Rover shows Interior Color
 *  - Park and Sell appears for JLR Financial Services
 *  - Hypothecation Yes shows bank name
 *
 * Success
 *  - happy path: valid SA VIN from master list creates the lead
 *
 * Edit is not part of this suite.
 */
test('Purchase Master add lead — all cases in one Chrome session', async ({ page }, testInfo) => {
  test.setTimeout(900000);
  const failures = await runLoginScenarios(page, testInfo);
  if (failures.length) {
    throw new Error(`${failures.length} scenario(s) failed:\n${failures.join('\n')}`);
  }
});
