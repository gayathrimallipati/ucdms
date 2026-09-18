const { test } = require('@playwright/test');
const { AUTH_STATE_PATH, ensureDealerSession, hasSavedDealerSession } = require('./helpers/login');
const { editChosenLead } = require('./helpers/pm-edit-lead');

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
  await ensureDealerSession(page);
  await editChosenLead(page, testInfo);
});
