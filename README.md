# UCDMS Playwright automation

Headed browser tests for Jaguar Land Rover Used Car DMS: dealer login, Purchase Master add/edit (through Purchased), and My Stock through Ready For Sale.

Public repo: [github.com/gayathrimallipati/ucdms](https://github.com/gayathrimallipati/ucdms)

## What you need

- **Node.js 18+** (LTS is fine)
- **Git**
- **Google Chrome** or **Microsoft Edge** (the suite uses system Chrome first, then Edge, then Playwright Chromium)
- Network access to the DMS you want to hit (`https://dms.jlr.local`, stage, or UAT)
- A dealer login that can add Purchase Master leads

Playwright ignores HTTPS certificate errors, so a local `dms.jlr.local` cert does not have to be trusted in the OS.

## Install

```bash
git clone https://github.com/gayathrimallipati/ucdms.git
cd ucdms
npm install
```

`npm install` also runs `npx playwright install chromium`. If Chrome/Edge are missing and Chromium did not install, run that command yourself.

## Configure

`.env` is **not** in git. Copy the example and edit it:

```bash
copy .env.example .env
```

On macOS / Linux:

```bash
cp .env.example .env
```

Minimum settings:

```env
DMS_URL=https://dms.jlr.local
DMS_EMAIL=dealer@cartrade.com
DMS_OTP=919919
DMS_HEADLESS=0
```

| Variable | Purpose |
| --- | --- |
| `DMS_URL` | DMS origin. Changing local / stage / UAT forces a new captcha + OTP login. |
| `DMS_EMAIL` | Dealer email |
| `DMS_OTP` | Login OTP. Local/DEV default `919919`. UAT is typically `369369`. |
| `DMS_BROWSER` | `chrome`, `msedge`, or `chromium`. Leave empty to try Chrome, then Edge, then Chromium. |
| `DMS_HEADLESS` | `0` = visible window (needed for edit/stock pickers). `1` = headless. |
| `DMS_PHOTOS_DIR` | Optional folders of `.jpg` / `.png` for Images-tab uploads. Leave empty to use `tests/fixtures/vehicle-photos` or generated PNGs. |
| `DMS_UPLOAD_DELAY_MS` | Pause between image uploads (default `1200`). Raise this if stage returns HTTP 429. |

Images still upload if `.env` has no photo folders. Place files under `tests/fixtures/vehicle-photos` or let the suite generate PNGs.

A missing `.env` is allowed: the scripts fall back to `https://dms.jlr.local`, `dealer@cartrade.com`, and OTP `919919`. You still need `.env` when the URL, email, or OTP is different on that machine.

## Run

Keep the browser window open. Do not close it until the script prints that it is done.

| Command | What it does |
| --- | --- |
| `npm test` | Login cases **and** all Purchase Master add cases. Never edit. |
| `npm run test:add` | One happy-path add. Reuses a saved dealer session when the host matches. |
| `npm run test:edit` | Edit only. **You pick the lead** in the Chrome overlay. |
| `npm run test:stock` | My Stock only. **You pick the INV ID** in the Chrome overlay. |
| `npm run test:flow` | One window: add → edit (pick the new PM ID) → stock (pick the INV) through Ready For Sale. |

```bash
npm run test:add
npm run test:flow
```

### Edit / stock / flow pickers

`test:edit`, `test:stock`, and the last two steps of `test:flow` wait on a panel in Chrome. Type or click the exact **Lead ID** (for example `PM103`) or **INV ID**. Do not rely on the top grid row — the script only opens the ID you chose.

On `test:flow`, the add step prints the new Lead ID. Pick that same ID in edit, then the matching inventory ID in My Stock.

### Login and sessions

- First run (or after the session expires): complete captcha + OTP in the opened Chrome window if the script cannot do it automatically.
- DEV captcha is read from the login API. UAT/stage captcha is read from the image (refresh on failure).
- Saved session: `test-results/auth/dealer.json`. It is reused only when it belongs to the **current** `DMS_URL` host. Switching environment always logs in again.
- `npm test` starts from a clean login page and does not reuse that file.

## Typical first run on a new PC

1. Clone and `npm install`
2. Copy `.env.example` → `.env` and set `DMS_URL` / `DMS_EMAIL` / `DMS_OTP` for that environment
3. Confirm Chrome (or Edge) is installed
4. Run `npm run test:add` and watch the headed window
5. For the full path, run `npm run test:flow` and pick the printed Lead ID, then the INV ID, when the overlays appear

## Troubleshooting

- **Wrong site / unexpected login** — `DMS_URL` host does not match the saved session. That is expected after changing local → stage → UAT. Log in once; the new session is saved.
- **Captcha loop on UAT/stage** — the image is OCR’d; wait for a few refresh attempts. Confirm `DMS_OTP` is the OTP for that environment.
- **“Chassis is required” / no VIN** — Jaguar/Land Rover add needs a 17-character VIN starting with `SA` from `master_jlr_total_vins`. Stage may not expose `getJlrVin`; the helper also tries other VIN list APIs. Optional override: `DMS_VIN=SA…` (17 chars).
- **Area / City / State empty** — pincode is not enough. The add flow waits for `getareasbypincode`, picks an area, then waits for `getstatecitybyarea`.
- **Images 429 on stage** — increase `DMS_UPLOAD_DELAY_MS` (for example `3000`). Uploads are skipped on `dms.jlr.local`.
- **No browser** — install Chrome or Edge, or run `npx playwright install chromium`.
- **Picker timed out** — choose the ID in the Chrome overlay before the wait ends; refresh the list if the new lead is not shown yet.

## What is not in git

These stay on each machine and must not be committed:

- `.env`
- `node_modules/`
- `test-results/` (screenshots, saved session, generated photos)
- `playwright-report/`
