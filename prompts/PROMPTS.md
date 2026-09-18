# UCDMS Playwright prompts

All prompts for this project in one file. Attach it in a new chat with `@prompts/PROMPTS.md`.

- App / source of truth (DMS): `c:\Users\Gayatri\OneDrive\Documents\docker\projects\dms.jlr.local`
- Automation project: `c:\Users\Gayatri\OneDrive\Documents\projects\ucdms`

---

## 1. Project setup

Site: `https://dms.jlr.local`

Dealer login:
- Email: `dealer@cartrade.com`
- OTP: `919919`
- Captcha: on DEV, read `data_optional.captcha_code` from the API. On UAT/stage that field is omitted (`env_server !== 'dev'`), so read the captcha image and retry with refresh — do not sit on the login page waiting for a typed captcha.

Commands:
- `npm test` — login scenarios + all add-lead cases (never edit)
- `npm run test:add` — one happy-path Purchase Master add (reuse dealer session)
- `npm run test:edit` — edit flow only (user picks the lead in the browser)
- `npm run test:stock` — My Stock only (user picks the exact INV ID in the browser)
- `npm run test:flow` — one window: add once → edit (pick PM) → stock (pick INV) through Ready For Sale

Headed Chrome, one window, ignore HTTPS errors. Must also run on other machines (Chrome / Edge / Playwright Chromium).

Optional `.env`:

```
DMS_URL=https://dms.jlr.local
DMS_EMAIL=dealer@cartrade.com
DMS_OTP=919919
DMS_BROWSER=chrome
DMS_HEADLESS=0
DMS_EVAL_STRATEGY=mixed        # mixed | ok | notok
DMS_REFURB_COST_CHANCE=0.5     # share of questions that get a random Ref. Exp amount; 0 disables
DMS_STOCK_LISTING_PRICE=249000 # used only when listing_price is 0; Ready For Sale requires a non-zero price
```

---

## 2. Login

Log in with the dealer credentials. Captcha comes from `data_optional.captcha_code` on DEV, or from the captcha image on UAT/stage. OTP is `DMS_OTP` (919919 locally, 369369 on UAT).

Write multiple login scenarios: valid, invalid email, unknown user, wrong captcha, wrong OTP, empty fields.

Rules:
- Open the browser **once**. Run every login scenario in that same window; do not relaunch Chrome per case.
- On failure, record it as a failed case, capture a screenshot (`test-results/failed-cases/`), reset the form, continue.

For **edit** (`npm run test:edit`): reuse the saved session (`test-results/auth/dealer.json`) only when it matches the current `DMS_URL` origin. Login (captcha + OTP) the first time, when the session expired, or after you change host (local → stage → UAT). Cookies and `jlr_logged` do not carry across domains. Do **not** reuse that session for `npm test`, which needs a clean login page.

---

## 3. Add Purchase Master lead

After login, in the **same** session, add a Purchase Master lead.

Fill every field, including the custom components from the DMS codebase:
- SelectSearch dropdowns (Source, Sub Source, Make, Model, Variant, colors, Branch, Executive, …)
- DateTimePicker
- pin_code_search (type 3–6 digits, wait for the area dropdown, pick an option)
- Vaahan / Verify addons when visible

Write **all add-lead test cases, including negatives**. Do **not** include edit in the add suite.

Negatives:
- Empty submit
- Invalid email / mobile
- VIN that does not start with SA (Jaguar / Land Rover)
- VIN starting with SA but not in `master_jlr_total_vins`

Happy path: a valid JLR VIN from `master_jlr_total_vins` via `getJlrVin`. Chassis is required for registered JLR vehicles. Fill it last (after MMV) from that list — 17 characters starting with SA. If `getJlrVin` returns nothing, fail instead of submitting an empty VIN ("Chassis is required"). Optional override: `DMS_VIN`.

Run: `npm test` (all add cases) or `npm run test:add` (one happy-path lead). Combined add → edit → stock: `npm run test:flow`.

---

## 4. Edit Purchase Master lead

Keep edit **separate** from add.

The user chooses the lead **in the Chrome window** (overlay picker), not the terminal. Never open the top grid row unless that is the ID they picked.

Flow:
1. Reuse the saved dealer session, otherwise login once.
2. Open the Purchase Master list.
3. User picks a Lead ID in the browser (example: PM1).
4. Find that row by the exact text `Lead ID: PM1` (not a partial match that also hits PM10). Wait for the list API (`getlist`); do not read rows while the grid is still empty.
5. Open the lead with **View**.
6. If the add form (`#source`) is present, fill all details and dependents, then submit. If only Overview, skip the fill and go to STATUS.
7. Continue with section 5.

Run: `npm run test:edit`

---

## 5. Status, Evaluation, Images

After Lead Details, click sidebar **STATUS**.

### Status of Lead

Evaluation is **not** a main status. Set:
- **Status** → Follow up
- **Sub Status** → Evaluation Scheduled (never fall back to Appointment Fixed)
- **Lead Classification** → a real option (Hot / Warm / Cold); placeholder text is not a value
- **Evaluation Place** → a real option (Showroom / Field / Workshop); appears after Evaluation Scheduled
- **Next follow-up date** → a valid future date **and** time; click a calendar day, not the hour/minute column, then Done
- **Remarks** → required, at least 10 characters

Do not click UPDATE until those are really selected.

### Evaluation tab

If a **Latest Evaluation Details** popup appears (`getleadevaluation` info list — previous evaluation date/dealer/city), click **OK** and continue the checklist. It is informational, not a completed-evaluation stop, and it can show on any lead.

If evaluation is **already completed**, skip the checklist and go straight to Images. Completed means `evaluation_done = 'y'` (the Download Report button renders), the overview Status badge says **Completed**, or the checklist is read-only. Only fill the checklist when it is not completed.

Complete the checklist. **Do not upload images on evaluation questions.**

Pick one strategy per run at random:
- **mixed** — OK or Not OK per question
- **all-ok** — OK everywhere
- **all-not-ok** — Not OK everywhere

Sub-options and remarks are configured **per option** in admin (`subOptionsRequired` / `remarksRequired` in `class_evaluation-checklist.php`), so **OK can require them too**. After selecting any option:
- select a sub-option if one renders
- fill remarks if the remarks box is shown
- give a **random amount** to a **random subset** of the questions that render `Est. Ref. Exp` / `Act. Ref. Exp` (digits only, `maxlength` 9, optional server-side), leaving the rest blank. Never overwrite an amount that is already filled. `DMS_REFURB_COST_CHANCE` controls how many get one.

Expand **every** accordion section before answering. The section body is `v-show`, so questions in a collapsed section sit in the DOM but are hidden and cannot be checked. Never walk an indexed `.accordion-button.collapsed` locator — expanding a section removes it from the match set, so the loop stops after the first section and the rest are left blank. Snapshot the collapsed buttons in one `page.evaluate` pass, then re-open per question if one is still closed.

Questions without radios (numeric, video URL) still need a value. If submit reports missing fields, re-fill the flagged questions and submit again.

### Images tab

**Skip image uploads on `dms.jlr.local`** (local Docker). Do not open the Images tab or click UPLOAD there. On other domains, upload as below.

Upload vehicle photos here only. `tests/helpers/vehicle-photos.js` resolves them
in this order, so the suite runs on any machine:

1. `DMS_PHOTOS_DIR` / `DMS_JAGUAR_IMAGES` / `DMS_LANDROVER_IMAGES` in `.env` (comma separated)
2. `tests/fixtures/vehicle-photos` inside the repo
3. `c:\Users\Gayatri\OneDrive\Pictures\Jaguar Latest` + `...\Land Rover Images`, when present
4. generated 1024×768 PNGs in `test-results/fixtures/`

Never hardcode a new machine-specific path — add it to `.env` instead.

Upload **only the mandatory cards** — the ones whose header shows a red `*`
(`isRequired` in `getImageConfig()`; **22 of the 33 slots** — the 22 named shots,
not the 11 Other Image cards). Skip a mandatory card
that already has a saved image. Only mandatory images gate the move to
Purchased, and every extra upload is two more requests.

**Never fire all uploads at once.** `stage.ucdms.in` is behind a rate limiter —
nothing in the app returns 429 — and it blocks for minutes once tripped. Each
upload costs two requests (`uploadimages` plus the `getDetail` refresh), so
upload one card at a time and wait `DMS_UPLOAD_DELAY_MS` (default 1200 ms)
between cards. On a 429, pause `DMS_RATE_LIMIT_WAIT_MS` (default 60 s) and
resume rather than retrying immediately.

Source photos must be `.jpg`/`.jpeg`/`.png`; `images.js` rejects anything else
with "Only JPG, JPEG, PNG allowed".

Confirm success from the upload API response (`HTTP 200`, body `status: ok`), not
from the local blurred `blob:` preview. Do not disable the API's file-security
checks (tag/file required, MIME/extension, 10 MB limit, S3 configuration).

Match the upload response by its `uploadimages` POST body, not by URL — the API
host and path come from `g.$base_url_api` and differ per environment. If the
UPLOAD button refuses a real click (the card animates on hover and the button
sits under a blurred overlay), fall back to a DOM `el.click()`, which still
fires `enqueueUpload(key)`. Log the API `msg` when a card fails.

**Never wait for `networkidle` around uploads.** The app polls, and `getDetail()`
re-fetches every thumbnail after each success, so it never settles and each card
burns the full timeout. Wait on the `uploadimages` response instead, then poll
the card's `img src` briefly. Keep the real-click timeout short (the DOM click
fallback is instant) and only retry a card when the failure is retryable
(no response / click refused), never when the API rejected the file.

### Move the lead up to Purchased

Once evaluation is complete, walk the status ladder one step at a time until the
lead is **Purchased**: Fresh → Follow up → **Deal Done** → **Purchased**.
`class_configs.php` only enables the next status, so never try to jump.

Per step (fill **after** picking the status — changing it clears sub_status,
followup_date and remarks):
- **Deal Done** — Sub Status `Token Paid`, plus Customer Expected Price,
  Estimated Refurbishment Cost, Retailer Offered Price, Provisioned Margin,
  Agreed Price and Token Amount. The API rejects Deal Done unless
  `evaluation_done = 'y'` ("Please complete the evaluation before moving to Deal Done").
- **Purchased** — Before picking Purchased, open **IMAGES** and upload any missing mandatory photos (22 named shots). Then fill Final Purchase Price, Exchange = No, and every **mandatory** Purchase file (red `*`): Price Agreement (`file_doc1`) always, and RC (`file_doc2`) when the field shows `*`. Do not upload a file that is visible but not required. The API runs `validate_mandatory_images()`, so Deal Done will not move to Purchased until those photos are in `sellleads_images`. If the lead is already Deal Done, skip Evaluation and still do this Purchased step.

Confirm each step from the `updatestatus` response (`status: ok`) and log
`body.errors` when it fails. Stop at the status the app refuses to leave.

Because image uploads are skipped on `dms.jlr.local`, a lead there normally
stops at **Deal Done** — Purchased needs the mandatory images server-side.

---

## 6. My Stock

Keep My Stock separate from both add-lead and Purchase Master edit.

Run: `npm run test:stock`

Flow:
1. Reuse the saved dealer session, otherwise login once.
2. Open My Stock and let the user choose an exact `INV` ID in the Chrome overlay panel, exactly like the Purchase Master edit picker: list the visible stock, allow typing an ID, **Refresh list from grid**, and **Cancel**. Re-prompt on an invalid entry. Never open a row automatically.
   The picker uses click delegation and mirrors the choice into `sessionStorage`, and it re-opens itself if the SPA removes it, so a click on a suggested ID is never dropped. The chosen row is then found with the **same DOM scan that built the suggestion list** and tagged with `data-dms-stock-row` before clicking, so the picker and the opener can never disagree. `View` is matched loosely (`common_grid.js` renders it as icon + label, so its accessible name is not exactly "View"), falling back to the row's own `detail/:id` href. Grid search must be scoped: `page.locator('.search-filter').getByRole('button', { name: /^Search$/i })` — an unscoped lookup resolves to the advanced-filter modal's hidden Search button and times out.
3. Open Stock Detail and update only fields that the logged-in user can edit. Never alter read-only identity, make/model/variant, registration, or manufacturing data to force certification. **Click the visible footer Submit/Confirm** — do not use `form … last()`, because another mounted form often has a hidden Submit and the click is skipped. **Listing price cannot be 0**: `saveEvaluation`, `skipEvaluation` and `updateCertification` refuse Ready For Sale with "Please enter listing price for this vehicle". If the saved price is 0/null, override it with `DMS_STOCK_LISTING_PRICE`, the Indicative Selling Price, or a random ₹249,000–₹399,000 value, submit Stock Details, and confirm from `getlead` that `listing_price > 0` before moving status.
4. Complete the Post-Refurbishment Evaluation Checklist. **Skip Demo Section completely**: do not expand it and do not answer its questions. Select only certification-safe answers in real sections: **OK, Yes, No, N/A, or To be checked later**. Never select **Not OK**. Fill rendered sub-options and remarks; do not upload question images. **If post-refurbishment is already completed** (`evaluation_done = y`, Download Report, Completed badge, or a read-only checklist), skip the checklist and open the **Certification** tab. Do not wait for inventory status 2 — `getlead.detail.status` can stay `1` after a completed evaluation; `savecertification` still accepts that and can move the stock to status 3.
5. Check certification:
   - make must be JLR: `is_certifiable = y` controls the certification UI, while `is_brand_group = y` controls the backend status transition. These flags must agree; stop and report a make configuration error if they differ.
   - post-refurbishment must have no Not OK certification answer
   - **Refurbishment Not Done must not be set**; when it is set, the vehicle cannot be JLR Approved and must follow the Non-Certified path
   - age must be strictly under 5 years
   - mileage must be strictly under 125,000 km
6. Select **Certification type** first. Upload Images-tab photos **only when the type is JLR Approved**. `savecertification` runs `validate_mandatory_images()` only when `certification_type = 1`, so Non-Certified must not upload. Fill the Certification Checklist with **Yes** only for JLR Approved; leave those radios unanswered for Non-Certified (the API requires Yes answers only for type 1). Skip uploads on `dms.jlr.local`.
7. Finish at inventory status **3 — Ready For Sale** and confirm it by re-reading `getlead`:
   - Completing post-refurbishment sends a **non-JLR** stock directly from status 1 to status 3. Certification is not applicable.
   - For **JLR**, do not fail the run waiting for status 2. Open Certification once post-refurbishment is done, even if status is still 1. If every condition passes, submit `JLR Approved`; otherwise—including Refurbishment Not Done—submit `Non-Certified`. Click the visible **Confirm** (stage) / **Submit** (local) button, then **Yes** on the `$confirmToast` ("Are you sure you want to proceed with Non-Certified submission?" or the JLR Approved equivalent). Target `button.btn-ok`, not the form Confirm. That Yes is required for `savecertification` and Ready For Sale. Fall back to the API only if Yes still does not produce a response. `savecertification` then moves it to status 3.
   - If a stock is already status 3, do not submit certification again.
   - If the expected transition is rejected, stop and report the API message; never claim completion before `getlead.detail.status` equals `3`.

The app derives age from registration date for registered vehicles and from manufacturing month/year for unregistered vehicles. Those fields are read-only in My Stock, so the automation reports an age failure instead of changing them.

---

## 7. VIN, dropdowns, dependents

### Jaguar / Land Rover VIN
- 17 characters, starts with **SA**, exists in `master_jlr_total_vins`
- Never use fake VINs like `MAT…` for Jaguar / Land Rover

### Dropdowns
- Pick **different** options each run (MMV, pincode, branch); do not always take the first
- Wait until SelectSearch has real options; the placeholder ("Select …" or the muted field label) is not a value
- Pincode: after 3 digits the area dropdown must appear; pick an area
- Colors: wait for `dynamic_colors` after Make; interior color is JLR-only

### Dependent fields
Whenever a parent is set, fill every dependent that becomes visible:
- Source = Service to Sales → **WPS** (after Branch)
- Title = M/s → **Company Name**
- Source → Sub Source
- Branch → Executive
- Make → Model → Variant → colors
- JLR FS → Park and Sell
- Hypothecation Yes → bank
- Status → sub_status, follow-up date, evaluation place

---

## 8. Original requests (exact wording)

1. Local setup is `c:\Users\Gayatri\OneDrive\Documents\docker\projects\dms.jlr.local`. Login with `dealer@cartrade.com` and OTP `919919`. Captcha is in the code — read it from there.
2. Run it using Playwright.
3. Put this code in `c:\Users\Gayatri\OneDrive\Documents\projects\ucdms`.
4. For the login page write multiple test cases so the complete form can be checked. For every failed case generate a report and capture an image.
5. Run in headed mode.
6. On testing multiple scenarios, do not open the browser multiple times. Open Chrome once and check all scenarios there.
7. In the same session add a lead in Purchase Master. There are custom components — check those and create a lead.
8. This code has to run on other systems, not only this one.
9. Edit the lead with all lead details filled. Do not edit the lead on the top. Ask which Lead ID the user wants to edit.
10. Take `dms.jlr.local` as the codebase and fill custom-component fields too.
11. For Jaguar Land Rover the VIN must start with SA and must come from `master_jlr_total_vins`. Also select different options each time for MMV, pincode, and other dropdowns.
12. Write all test cases for adding a lead in PM.
13. Do not include edit in adding a lead. Check all add-lead scenarios including negative test cases.
14. I need a report. Give me the command to view this report.
15. Write edit separately. The lead to edit must be chosen by the user in the browser.
16. After the Lead ID is given, open that lead. Do not fail while the row is visible.
17. When there are dependent fields, fill those also.
18. After Lead Details, click STATUS and update the lead. Once the lead is in Evaluation, complete evaluation from the Evaluation tab.
19. Why adding a template showed Internal server error on admin.
20. Use images from the Jaguar Latest and Land Rover Images folders for file upload. If there is a session, do not login every time on edit.
21. Do not upload images for evaluation. Upload images only on the Images tab. On the Status tab select Status of Lead for evaluation.
22. Select the sub-options; remarks are mandatory when selecting Not OK.
23. Also select Lead Classification, Next follow-up date and Evaluation Place on the Status tab.
24. For evaluation select both options randomly, or all OK, or all Not OK.
25. Even on selecting OK, sub-options are mandatory — refer to the codebase and select options.
26. Why "Failed to update image" instead of uploading. Keep all the prompts in one file.
27. Skip Images-tab uploading on the `dms.jlr.local` domain.
28. Once evaluation is completed, move the lead to the next status and keep going until Purchased.
29. Upload only the mandatory images, and stop triggering "too many requests" blocks.
30. Create a separate stock workflow that updates enabled stock details, completes post-refurbishment evaluation without Not OK, and checks JLR certification including age and mileage.
