const path = require('path');
require(path.join(__dirname, 'tests/helpers/browser'));

const channel = (() => {
  const name = String(process.env.DMS_BROWSER || '').trim().toLowerCase();
  if (!name || name === 'chromium') return undefined;
  return name;
})();

const headless = ['1', 'true', 'yes'].includes(String(process.env.DMS_HEADLESS || '').toLowerCase());

module.exports = require('@playwright/test').defineConfig({
  testDir: './tests',
  timeout: 600000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.DMS_URL || 'https://dms.jlr.local',
    ignoreHTTPSErrors: true,
    ...(channel ? { channel } : {}),
    headless,
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
});
