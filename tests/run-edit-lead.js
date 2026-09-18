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

async function main() {
  console.log('[edit] Opening one browser window…');
  const browser = await launchBrowser();
  const context = await newAppContext(browser, { reuseSession: true });
  const page = await context.newPage();

  console.log('[edit] Using saved session if one exists (login only when needed)…');
  await ensureDealerSession(page);
  console.log(`[edit] Ready → ${page.url()}`);

  const result = await editChosenLead(page);
  await saveDealerSession(context);
  console.log(`\n[edit] Done. Updated ${result.leadId}`);
  console.log('[edit] Browser left open. Close the window when done.');
}

main().catch((err) => {
  console.error('[edit] Failed:', err.message);
  process.exitCode = 1;
});
