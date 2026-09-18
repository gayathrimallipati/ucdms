/**
 * DMS dealer login agent (Playwright)
 *
 * Flow: open /login → read captcha from DEV API → fill email → LOGIN → OTP → Submit
 *
 *   npm install
 *   npx playwright install chromium
 *   npm run login
 */

const { launchBrowser, newAppContext, baseURL } = require('./tests/helpers/browser');

const BASE_URL = baseURL();
const EMAIL = process.env.DMS_EMAIL || 'dealer@cartrade.com';
const OTP = process.env.DMS_OTP || '919919';

function captchaFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  const code = body.data_optional?.captcha_code || body.data?.captcha_code;
  return code ? String(code).trim() : null;
}

async function parseJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForCaptchaCode(page, timeoutMs = 20000) {
  const res = await page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'POST' || !r.ok()) return false;
      if (!r.url().includes('/apis')) return false;
      const body = await parseJson(r);
      return Boolean(captchaFromBody(body));
    },
    { timeout: timeoutMs }
  );
  return captchaFromBody(await parseJson(res));
}

async function fillOtp(page, otp) {
  const boxes = page.locator('input.otp-digit');
  await boxes.first().waitFor({ state: 'visible', timeout: 15000 });

  await boxes.first().click();
  await page.keyboard.insertText(otp);

  const joined = await boxes.evaluateAll((els) => els.map((el) => el.value).join(''));
  if (joined === otp) return;

  for (let i = 0; i < otp.length; i++) {
    await boxes.nth(i).fill(otp[i]);
  }
}

async function run() {
  const browser = await launchBrowser();
  const context = await newAppContext(browser);
  const page = await context.newPage();

  let captchaCode = null;
  page.on('response', async (res) => {
    if (res.request().method() !== 'POST' || !res.url().includes('/apis')) return;
    const code = captchaFromBody(await parseJson(res));
    if (code) captchaCode = code;
  });

  console.log(`[agent] Opening ${BASE_URL}/login`);
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });

  const emailInput = page.locator('input[placeholder="Email Address"]');
  const captchaInput = page.locator('input[placeholder="Captcha"]');
  await emailInput.waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('img.captcha-img').waitFor({ state: 'visible', timeout: 20000 });

  if (!captchaCode) {
    console.log('[agent] Waiting for captcha API…');
    captchaCode = await waitForCaptchaCode(page).catch(() => null);
  }
  if (!captchaCode) {
    throw new Error('Could not read captcha. DEV API should return data_optional.captcha_code.');
  }
  console.log(`[agent] Captcha: ${captchaCode}`);

  await emailInput.fill(EMAIL);
  await captchaInput.fill(captchaCode);
  console.log(`[agent] Email: ${EMAIL} — clicking LOGIN`);
  await page.getByRole('button', { name: /^LOGIN$/i }).click();

  console.log(`[agent] OTP: ${OTP}`);
  await fillOtp(page, OTP);
  await page.getByRole('button', { name: /^Submit$/i }).click();

  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20000 });
  console.log(`[agent] Logged in → ${page.url()}`);

  // Keep the browser open so you can use the session
  console.log('[agent] Browser left open. Close the window or press Ctrl+C to exit.');
}

run().catch(async (err) => {
  console.error('[agent] Failed:', err.message);
  process.exitCode = 1;
});
