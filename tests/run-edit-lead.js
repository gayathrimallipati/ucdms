/**
 * Purchase Master edit — separate from add-lead (npm test).
 *
 * Reuses a saved dealer session when it is still valid (login only once).
 * Opens the lead list and waits for you to pick a lead in the Chrome panel.
 * Only that lead is opened and updated.
 *
 *   npm run test:edit
 */
const { launchBrowser, newAppContext } = require('./helpers/browser');
const { ensureDealerSession, saveDealerSession } = require('./helpers/login');
const { editChosenLead } = require('./helpers/pm-edit-lead');
const { createRunReport } = require('./helpers/run-report');

async function main() {
  const report = createRunReport('npm run test:edit');
  console.log('[edit] Opening one browser window…');
  const browser = await launchBrowser();
  const context = await newAppContext(browser, { reuseSession: true });
  const page = await context.newPage();

  try {
    console.log('[edit] Using saved session if one exists (login only when needed)…');
    await report.step('Login / session', () => ensureDealerSession(page), page);
    console.log(`[edit] Ready → ${page.url()}`);

    const result = await report.step('Edit chosen Purchase Master lead', () => editChosenLead(page), page);
    await saveDealerSession(context);
    if (result?.leadId) report.note(`Updated ${result.leadId}`);
    report.finish({ leadId: result?.leadId || '' });
    console.log(`\n[edit] Done. Updated ${result.leadId}`);
    console.log('[edit] Browser left open. Close the window when done.');
  } catch (err) {
    report.finish({ error: err });
    throw err;
  }
}

main().catch((err) => {
  console.error('[edit] Failed:', err.message);
  process.exitCode = 1;
});
