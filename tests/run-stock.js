/**
 * My Stock workflow — separate from add-lead and Purchase Master edit.
 *
 * The user chooses the exact INV ID in Chrome. The workflow updates only
 * enabled stock fields, completes post-refurbishment without Not OK answers,
 * then checks and submits the applicable certification result.
 *
 *   npm run test:stock
 */
const { launchBrowser, newAppContext } = require('./helpers/browser');
const { ensureDealerSession, saveDealerSession } = require('./helpers/login');
const { runStockWorkflow } = require('./helpers/stock-workflow');

async function main() {
  console.log('[stock] Opening one browser window…');
  const browser = await launchBrowser();
  const context = await newAppContext(browser, { reuseSession: true });
  const page = await context.newPage();

  console.log('[stock] Reusing the saved dealer session when valid…');
  await ensureDealerSession(page);
  const result = await runStockWorkflow(page);
  await saveDealerSession(context);

  console.log(`\n[stock] Done: ${result.stockId}`);
  console.log(`[stock] Certification: ${result.certification.certificationType || 'not applicable'}`);
  console.log(`[stock] Eligible: ${result.certification.eligible ? 'yes' : 'no'}`);
  console.log(`[stock] Ready For Sale: ${result.certification.readyForSale ? 'yes' : 'no'}`);
  if (result.certification.message) console.log(`[stock] Server: ${result.certification.message}`);
  console.log('[stock] Browser left open. Close the window when done.');
}

main().catch((error) => {
  console.error('[stock] Failed:', error.message);
  process.exitCode = 1;
});
