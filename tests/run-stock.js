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
const { createRunReport } = require('./helpers/run-report');

async function main() {
  const report = createRunReport('npm run test:stock');
  console.log('[stock] Opening one browser window…');
  const browser = await launchBrowser();
  const context = await newAppContext(browser, { reuseSession: true });
  const page = await context.newPage();

  try {
    console.log('[stock] Reusing the saved dealer session when valid…');
    await report.step('Login / session', () => ensureDealerSession(page), page);
    const result = await report.step('My Stock through Ready For Sale', () => runStockWorkflow(page), page);
    await saveDealerSession(context);
    const cert = result?.certification || {};
    report.note(`Stock ${result?.stockId || ''}`);
    report.note(`Certification: ${cert.certificationType || 'not applicable'}`);
    report.note(`Ready For Sale: ${cert.readyForSale ? 'yes' : 'no'}`);
    report.finish({
      stockId: result?.stockId || '',
      certification: cert.certificationType || '',
      readyForSale: Boolean(cert.readyForSale),
    });
    console.log(`\n[stock] Done: ${result.stockId}`);
    console.log(`[stock] Certification: ${cert.certificationType || 'not applicable'}`);
    console.log(`[stock] Eligible: ${cert.eligible ? 'yes' : 'no'}`);
    console.log(`[stock] Ready For Sale: ${cert.readyForSale ? 'yes' : 'no'}`);
    if (cert.message) console.log(`[stock] Server: ${cert.message}`);
    console.log('[stock] Browser left open. Close the window when done.');
  } catch (err) {
    report.finish({ error: err });
    throw err;
  }
}

main().catch((error) => {
  console.error('[stock] Failed:', error.message);
  process.exitCode = 1;
});
