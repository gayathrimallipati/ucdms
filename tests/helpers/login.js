const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

const VALID_EMAIL = process.env.DMS_EMAIL || 'dealer@cartrade.com';
const VALID_OTP = process.env.DMS_OTP || '919919';
const UNKNOWN_EMAIL = 'unregistered.user@example.com';
const FAILED_DIR = path.join(process.cwd(), 'test-results', 'failed-cases');
const AUTH_STATE_PATH = path.join(process.cwd(), 'test-results', 'auth', 'dealer.json');

function captchaFromBody(body) {
  const code = body?.data_optional?.captcha_code
    || body?.data_optional?._data?.data_optional?.captcha_code
    || body?.data?.captcha_code;
  return code ? String(code).trim() : null;
}

async function parseJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function listenForCaptcha(page) {
  const state = { code: null };
  page.on('response', async (res) => {
    if (res.request().method() !== 'POST' || !res.url().includes('/apis')) return;
    const code = captchaFromBody(await parseJson(res));
    if (code) state.code = code;
  });
  return state;
}

async function waitForCaptchaCode(page, timeoutMs = 3000) {
  const res = await page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'POST' || !r.ok() || !r.url().includes('/apis')) return false;
      return Boolean(captchaFromBody(await parseJson(r)));
    },
    { timeout: timeoutMs }
  );
  return captchaFromBody(await parseJson(res));
}

function normalizeCaptchaText(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function preparedCaptchaImage(page) {
  return page.locator('img.captcha-img').evaluate((img) => {
    const scale = 6;
    const width = Math.max(img.naturalWidth || img.width || 150, 1) * scale;
    const height = Math.max(img.naturalHeight || img.height || 50, 1) * scale;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const pixels = image.data;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
      const value = gray < 150 ? 0 : 255;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
    }
    const copy = new Uint8ClampedArray(pixels);
    const idx = (x, y) => (y * width + x) * 4;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let dark = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (copy[idx(x + dx, y + dy)] === 0) dark += 1;
          }
        }
        const i = idx(x, y);
        const value = dark < 3 ? 255 : 0;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
      }
    }
    const afterSpeckles = new Uint8ClampedArray(pixels);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let min = 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            min = Math.min(min, afterSpeckles[idx(x + dx, y + dy)]);
          }
        }
        const i = idx(x, y);
        pixels[i] = pixels[i + 1] = pixels[i + 2] = min;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  });
}

async function createCaptchaWorker() {
  try {
    const { createWorker } = require('tesseract.js');
    return createWorker('eng', 1, { logger: () => {} });
  } catch {
    return null;
  }
}

async function ocrCaptchaImage(page, worker) {
  await page.locator('img.captcha-img').waitFor({ state: 'visible', timeout: 20000 });
  if (!worker) return null;
  const prepared = await preparedCaptchaImage(page);
  for (const mode of ['8', '7', '13', '6']) {
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      tessedit_pageseg_mode: mode,
      user_defined_dpi: '300',
    });
    const { data } = await worker.recognize(prepared);
    const code = normalizeCaptchaText(data?.text);
    if (code.length === 5) return code;
  }
  return null;
}

async function readCaptcha(page, captcha, worker) {
  if (!captcha.code) {
    captcha.code = await waitForCaptchaCode(page, 800).catch(() => null);
  }
  if (captcha.code) return captcha.code;
  captcha.code = await ocrCaptchaImage(page, worker).catch(() => null);
  if (captcha.code) console.log(`[login] Captcha from image: ${captcha.code}`);
  return captcha.code;
}

async function fillOtp(page, otp) {
  const boxes = page.locator('input.otp-digit');
  await boxes.first().waitFor({ state: 'visible', timeout: 15000 });
  await clearOtp(page);
  await boxes.first().click();
  await page.keyboard.insertText(otp);

  const joined = await boxes.evaluateAll((els) => els.map((el) => el.value).join(''));
  if (joined === otp) return;

  for (let i = 0; i < otp.length; i++) {
    await boxes.nth(i).fill(otp[i]);
  }
}

async function clearOtp(page) {
  const boxes = page.locator('input.otp-digit');
  const count = await boxes.count();
  for (let i = 0; i < count; i++) {
    await boxes.nth(i).fill('');
  }
}

function slug(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

async function saveFailedLoginShot(page, testInfo, label) {
  fs.mkdirSync(FAILED_DIR, { recursive: true });
  const name = slug(label || testInfo?.title || 'failed-login');
  const file = path.join(FAILED_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  if (testInfo?.attach) {
    await testInfo.attach(`failed-login: ${name}`, { path: file, contentType: 'image/png' });
    testInfo.annotations.push({ type: 'failed-login', description: file });
  }
  console.log(`[failed-case] ${label}\n  image: ${file}`);
  return file;
}

function formError(page) {
  return page.locator('.modal-auth .alert.alert-danger');
}

function toast(page) {
  return page.locator('#alert-container .alert.my-toast').last();
}

async function loginAsDealer(page) {
  const captcha = listenForCaptcha(page);
  await page.goto('/login', { waitUntil: 'networkidle' });
  const email = page.locator('input[placeholder="Email Address"]');
  const captchaInput = page.locator('input[placeholder="Captcha"]');
  await email.waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('img.captcha-img').waitFor({ state: 'visible', timeout: 20000 });
  await email.fill(VALID_EMAIL);

  if (!captcha.code) {
    console.log('[login] UAT/stage omit data_optional.captcha_code — reading the image');
  }
  const worker = captcha.code ? null : await createCaptchaWorker();
  try {
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (attempt > 1) captcha.code = null;
      const code = await readCaptcha(page, captcha, worker);
      if (!code) {
        console.log(`[login] Captcha not read (attempt ${attempt}/8) — refreshing`);
        await page.locator('.captcha-refresh').click();
        await page.waitForTimeout(700);
        continue;
      }
      await captchaInput.fill(code);
      await page.getByRole('button', { name: /^LOGIN$/i }).click();
      const otpVisible = await page.locator('input.otp-digit').first()
        .waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      if (otpVisible) break;
      if (attempt === 8) {
        throw new Error('Could not read the UAT captcha after 8 image attempts.');
      }
      console.log(`[login] Captcha ${code} was rejected — refreshing (attempt ${attempt + 1}/8)`);
      await page.locator('.captcha-refresh').click();
      await page.waitForTimeout(700);
    }
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }

  await fillOtp(page, VALID_OTP);
  await page.getByRole('button', { name: /^Submit$/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20000 });
  await page.waitForFunction(() => Boolean(localStorage.getItem('jlr_logged')), { timeout: 15000 }).catch(() => {});
}

function hasSavedDealerSession() {
  try {
    return fs.existsSync(AUTH_STATE_PATH) && fs.statSync(AUTH_STATE_PATH).size > 20;
  } catch {
    return false;
  }
}

function currentOrigin() {
  try {
    return new URL(process.env.DMS_URL || 'https://dms.jlr.local').origin;
  } catch {
    return '';
  }
}

function savedSessionOrigins() {
  try {
    const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'));
    return (state.origins || []).map((entry) => entry.origin).filter(Boolean);
  } catch {
    return [];
  }
}

function sessionMatchesCurrentHost() {
  const origin = currentOrigin();
  return Boolean(origin) && savedSessionOrigins().includes(origin);
}

async function saveDealerSession(context) {
  if (!context) return;
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await context.storageState({ path: AUTH_STATE_PATH });
}

async function isLoginScreen(page) {
  const pathname = new URL(page.url()).pathname;
  if (/\/login\/?$/.test(pathname)) return true;
  const email = page.locator('input[placeholder="Email Address"]');
  if (await email.isVisible().catch(() => false)) return true;
  const logged = await page.evaluate(() => {
    try {
      return Boolean(localStorage.getItem('jlr_logged'));
    } catch {
      return false;
    }
  }).catch(() => false);
  return !logged;
}

/**
 * Reuse the saved dealer session when it is still valid.
 * Login (captcha + OTP) runs only on the first edit, or if the session expired.
 */
async function ensureDealerSession(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await Promise.race([
    page.locator('input[placeholder="Email Address"]').waitFor({ state: 'visible', timeout: 12000 }),
    page.locator('#sidebar-menu-list, .sidebar-container, a[href*="purchase-master"]').waitFor({ state: 'visible', timeout: 12000 }),
    page.waitForURL((url) => !/\/login\/?$/.test(url.pathname) && url.pathname.length > 1, { timeout: 12000 }),
  ]).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});

  if (await isLoginScreen(page)) {
    const saved = savedSessionOrigins();
    const current = currentOrigin();
    if (saved.length && current && !saved.includes(current)) {
      console.log(
        `[edit] Saved session is for ${saved.join(', ')} — DMS_URL is ${current}, so logging in again (captcha + OTP)`
      );
    } else {
      console.log('[edit] No valid session — logging in once (captcha + OTP)');
    }
    await loginAsDealer(page);
  } else {
    console.log('[edit] Reusing saved session — skip login');
  }

  await saveDealerSession(page.context());
}

module.exports = {
  VALID_EMAIL,
  VALID_OTP,
  UNKNOWN_EMAIL,
  FAILED_DIR,
  AUTH_STATE_PATH,
  listenForCaptcha,
  waitForCaptchaCode,
  readCaptcha,
  fillOtp,
  clearOtp,
  saveFailedLoginShot,
  formError,
  toast,
  loginAsDealer,
  hasSavedDealerSession,
  sessionMatchesCurrentHost,
  saveDealerSession,
  ensureDealerSession,
};
