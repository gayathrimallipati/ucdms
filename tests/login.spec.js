const { test } = require('@playwright/test');
const { runLoginScenarios } = require('./helpers/scenarios');
const { createRunReport } = require('./helpers/run-report');

test('login form — all scenarios in one Chrome session', async ({ page }, testInfo) => {
  test.setTimeout(600000);
  const report = createRunReport('playwright: login');
  const failures = await runLoginScenarios(page, testInfo, report);
  report.finish();
  if (failures.length) {
    throw new Error(`${failures.length} scenario(s) failed:\n${failures.join('\n')}`);
  }
});
