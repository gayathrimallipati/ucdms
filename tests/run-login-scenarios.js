/**
 * One browser window. One tab. Login scenarios, then every Purchase
 * Master add-lead case (including negative cases). Does not edit a lead.
 * Edit is a separate command: npm run test:edit
 *
 * Works on any machine with Node.js:
 *   npm install
 *   npx playwright install chromium
 *   npm test
 *
 * Optional .env in this folder:
 *   DMS_URL=https://dms.jlr.local
 *   DMS_EMAIL=dealer@cartrade.com
 *   DMS_OTP=919919
 *   DMS_BROWSER=chrome
 *   DMS_HEADLESS=0
 *   DMS_LEAD_ID=PM12345
 */

const { launchBrowser, newAppContext } = require('./helpers/browser');
const { runLoginScenarios } = require('./helpers/scenarios');

async function main() {
  console.log('[agent] Opening one browser window…');
  const browser = await launchBrowser();
  const context = await newAppContext(browser);
  const page = await context.newPage();

  console.log('[agent] Checking all scenarios in this one window (no reload between cases)');
  const failures = await runLoginScenarios(page);

  if (failures.length) {
    console.error(`\n[agent] ${failures.length} scenario(s) failed:\n${failures.join('\n')}`);
    console.error('[agent] Screenshots: test-results/failed-cases/');
    if (!process.env.CI) console.log('[agent] Browser left open so you can see the last screen. Close it when done.');
    else await browser.close();
    process.exitCode = 1;
    return;
  }

  console.log('\n[agent] All scenarios passed in this one browser window.');
  console.log('[agent] Failed-login screenshots: test-results/failed-cases/');
  if (!process.env.CI) console.log('[agent] Browser left open. Close the window when done.');
  else await browser.close();
}

main().catch((err) => {
  console.error('[agent] Failed:', err.message);
  process.exitCode = 1;
});
