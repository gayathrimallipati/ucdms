/**
 * One browser window: add a Purchase Master lead once, then edit that lead
 * through evaluation / Purchased, then My Stock through Ready For Sale.
 *
 * Does not replace npm test (login + add cases, never edit).
 *
 *   npm run test:flow
 *
 * You still pick the PM lead in the edit overlay, then the INV ID in the
 * stock overlay. The add step prints the new Lead ID so you can choose it.
 */
const { launchBrowser, newAppContext } = require('./helpers/browser');
const { ensureDealerSession, saveDealerSession } = require('./helpers/login');
const { createPurchaseLead } = require('./helpers/purchase-lead');
const { editChosenLead } = require('./helpers/pm-edit-lead');
const { runStockWorkflow } = require('./helpers/stock-workflow');
const { createRunReport } = require('./helpers/run-report');

async function main() {
  const report = createRunReport('npm run test:flow');
  console.log('[flow] Opening one browser window for add → edit → stock…');
  const browser = await launchBrowser();
  const context = await newAppContext(browser, { reuseSession: true });
  const page = await context.newPage();

  try {
    console.log('[flow] Reusing the saved dealer session when valid…');
    await report.step('Login / session', () => ensureDealerSession(page), page);

    console.log('\n[flow] 1/3 Purchase Master add (one lead)');
    const added = await report.step('Purchase Master add', () => createPurchaseLead(page), page);
    await saveDealerSession(context);
    if (added.leadId) {
      report.note(`Created ${added.leadId}`);
      console.log(`[flow] Created ${added.leadId}. Pick that ID in the edit panel next.`);
    } else {
      console.log('[flow] Lead created. Pick it in the edit panel next.');
    }

    console.log('\n[flow] 2/3 Purchase Master edit (pick the lead in Chrome)');
    const edited = await report.step('Purchase Master edit', () => editChosenLead(page), page);
    await saveDealerSession(context);
    console.log(`[flow] Edit finished for ${edited.leadId}. Pick the matching INV in My Stock next.`);

    console.log('\n[flow] 3/3 My Stock (pick the INV ID in Chrome)');
    const stock = await report.step('My Stock through Ready For Sale', () => runStockWorkflow(page), page);
    await saveDealerSession(context);

    report.note(`Lead: ${edited.leadId}`);
    report.note(`Stock: ${stock.stockId}`);
    report.note(`Certification: ${stock.certification.certificationType || 'not applicable'}`);
    report.note(`Ready For Sale: ${stock.certification.readyForSale ? 'yes' : 'no'}`);
    report.finish({
      leadId: edited.leadId,
      stockId: stock.stockId,
      certification: stock.certification.certificationType || '',
      readyForSale: Boolean(stock.certification.readyForSale),
    });

    console.log(`\n[flow] Done.`);
    console.log(`[flow] Lead: ${edited.leadId}`);
    console.log(`[flow] Stock: ${stock.stockId}`);
    console.log(`[flow] Certification: ${stock.certification.certificationType || 'not applicable'}`);
    console.log(`[flow] Ready For Sale: ${stock.certification.readyForSale ? 'yes' : 'no'}`);
    console.log('[flow] Browser left open. Close the window when done.');
  } catch (err) {
    report.finish({ error: err });
    throw err;
  }
}

main().catch((err) => {
  console.error('[flow] Failed:', err.message);
  process.exitCode = 1;
});
