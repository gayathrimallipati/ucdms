const { test } = require('@playwright/test');
const { runLoginScenarios } = require('./helpers/scenarios');

test('login form — all scenarios in one Chrome session', async ({ page }, testInfo) => {
  test.setTimeout(600000);
  const failures = await runLoginScenarios(page, testInfo);
  if (failures.length) {
    throw new Error(`${failures.length} scenario(s) failed:\n${failures.join('\n')}`);
  }
});
