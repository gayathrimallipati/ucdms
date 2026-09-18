/**
 * Purchase Master add — one happy-path lead. Not the full login/negative suite.
 *
 *   npm run test:add
 *
 * Full add cases (login + negatives + happy path) stay on: npm test
 * Edit stays on: npm run test:edit
 */
const { launchBrowser, newAppContext } = require('./helpers/browser');
const { ensureDealerSession, saveDealerSession } = require('./helpers/login');
const { createPurchaseLead } = require('./helpers/purchase-lead');

async function main() {
  console.log('[add] Opening one browser window…');
  const browser = await launchBrowser();
  try {
    const context = await newAppContext(browser, { reuseSession: true });
    const page = await context.newPage();

    console.log('[add] Reusing the saved dealer session when valid…');
    await ensureDealerSession(page);
    const result = await createPurchaseLead(page);
    await saveDealerSession(context);

    console.log(`\n[add] Done. Created ${result.leadId || '(lead id not read)'}`);
    console.log('[add] Next: npm run test:edit  (pick that PM in Chrome)');
    console.log('[add] Browser left open. Close the window when done.');
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error('[add] Failed:', err.message);
  process.exit(1);
});
