const { test } = require('@playwright/test');
const { AUTH_STATE_PATH, ensureDealerSession, hasSavedDealerSession } = require('./helpers/login');
const { editChosenLead } = require('./helpers/pm-edit-lead');
const { createRunReport } = require('./helpers/run-report');

if (hasSavedDealerSession()) {
  test.use({ storageState: AUTH_STATE_PATH });
}

/**
 * Purchase Master edit — separate from add-lead.
 * The user chooses the lead in the browser. Not run by npm test.
 *
 *   npm run test:edit
 */
test('Purchase Master edit — user chooses the lead in the browser', async ({ page }, testInfo) => {
  test.setTimeout(900000);
  test.skip(!process.env.DMS_EDIT, 'Edit is a separate suite. Run npm run test:edit');
  const report = createRunReport('playwright: edit');
  try {
    await report.step('Login / session', () => ensureDealerSession(page), page);
    const result = await report.step('Edit chosen lead', () => editChosenLead(page, testInfo), page);
    report.finish({ leadId: result?.leadId || '' });
  } catch (err) {
    report.finish({ error: err });
    throw err;
  }
});
