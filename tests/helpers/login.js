const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { expect } = require('@playwright/test');

(function loadEnvFile() {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

function dmsUrl() {
  return process.env.DMS_URL || 'https://dms.jlr.local';
}

function isUatHost(url = dmsUrl()) {
  try {
    return /\buat\b/i.test(new URL(url).hostname);
  } catch {
    return /uat/i.test(String(url));
  }
}

/** Same as DMS generateNumericOtp: uat → 369369, dev → 919919. */
function dealerOtp(envServer = '') {
  const env = String(envServer || '').toLowerCase();
  if (env === 'uat' || isUatHost()) return '369369';
  if (env === 'dev' || env === 'development') return '919919';
  return process.env.DMS_OTP || '919919';
}

async function otpForPage(page) {
  return dealerOtp(await envServer(page));
}

const VALID_EMAIL = process.env.DMS_EMAIL || 'dealer@cartrade.com';
const VALID_OTP = dealerOtp();
const UNKNOWN_EMAIL = 'unregistered.user@example.com';
const FAILED_DIR = path.join(process.cwd(), 'test-results', 'failed-cases');
const AUTH_STATE_PATH = path.join(process.cwd(), 'test-results', 'auth', 'dealer.json');

let encryptionConfig;
let loggedMissingEncrypt = false;

function configPhpCandidates() {
  return [
    process.env.DMS_CONFIG_PHP,
    path.resolve(__dirname, '../../../../docker/projects/config.php'),
    path.resolve(process.cwd(), '../../docker/projects/config.php'),
    path.resolve(process.cwd(), '../docker/projects/config.php'),
  ].filter(Boolean);
}

function loadEncryptionConfig() {
  const crypt_type = process.env.DMS_DATA_CRYPT_TYPE || 'AES-256-CBC';
  const iv = process.env.DMS_DATA_IV || '0'.repeat(16);
  if (process.env.DMS_DATA_SECRET_KEY) {
    return { secret_key: process.env.DMS_DATA_SECRET_KEY, crypt_type, iv };
  }
  for (const file of configPhpCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const php = fs.readFileSync(file, 'utf8');
      const block = php.match(/'encryption'\s*=>\s*\[[\s\S]*?\]/);
      const src = block ? block[0] : php;
      const secret = src.match(/'secret_key'\s*=>\s*'([^']+)'/);
      const crypt = src.match(/'crypt_type'\s*=>\s*'([^']+)'/);
      if (secret) {
        return {
          secret_key: secret[1],
          crypt_type: crypt?.[1] || crypt_type,
          iv,
          source: file,
        };
      }
    } catch {
      // try the next path
    }
  }
  return { secret_key: '', crypt_type, iv };
}

function getEncryptionConfig() {
  if (!encryptionConfig) encryptionConfig = loadEncryptionConfig();
  return encryptionConfig;
}

function opensslKeyIv(secret, iv, algorithm) {
  const keyLen = /256/.test(algorithm) ? 32 : /192/.test(algorithm) ? 24 : 16;
  const key = Buffer.alloc(keyLen);
  Buffer.from(String(secret), 'utf8').copy(key);
  let ivBuf = Buffer.from(String(iv), 'utf8');
  if (ivBuf.length < 16) ivBuf = Buffer.concat([ivBuf, Buffer.alloc(16 - ivBuf.length)]);
  if (ivBuf.length > 16) ivBuf = ivBuf.subarray(0, 16);
  return { key, iv: ivBuf, algorithm: String(algorithm || 'AES-256-CBC').toLowerCase() };
}

function opensslDecryptBase64(ciphertext, secret, algorithm, iv) {
  const cfg = opensslKeyIv(secret, iv, algorithm);
  const raw = Buffer.from(String(ciphertext), 'base64');
  const decipher = crypto.createDecipheriv(cfg.algorithm, cfg.key, cfg.iv);
  return Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8');
}

/** Match DMS `data_decrypt` in common_functions.php (double then single Base64 AES). */
function dataDecrypt(pass) {
  const { secret_key, crypt_type, iv } = getEncryptionConfig();
  if (!pass) return '';
  const passStr = String(pass);
  if (!secret_key || !crypt_type || !iv) return passStr;
  try {
    const decoded = Buffer.from(passStr, 'base64');
    if (decoded.length) {
      const inner = decoded.toString('utf8');
      try {
        const out = opensslDecryptBase64(inner, secret_key, crypt_type, iv);
        if (out) return out;
      } catch {
        // Method 2 below
      }
    }
  } catch {
    // Method 2
  }
  try {
    return opensslDecryptBase64(passStr, secret_key, crypt_type, iv) || '';
  } catch {
    return '';
  }
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = payload.length % 4;
  if (pad) payload += '='.repeat(4 - pad);
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function looksLikeCaptcha(value) {
  return /^[A-Za-z0-9]{5}$/.test(String(value || '').trim());
}

function captchaFromEncryptedField(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (looksLikeCaptcha(raw)) return raw;
  const decrypted = String(dataDecrypt(raw) || '').trim();
  return looksLikeCaptcha(decrypted) ? decrypted : null;
}

/** Same as verifyCaptcha: JWT payload.captcha_code → data_decrypt. */
function decryptCaptchaFromJwt(token) {
  const payload = decodeJwtPayload(token);
  if (!payload?.captcha_code) return null;
  return captchaFromEncryptedField(payload.captcha_code);
}

function captchaFromBody(body) {
  const code = body?.data_optional?.captcha_code
    || body?.data_optional?._data?.data_optional?.captcha_code
    || body?.data?.captcha_code;
  const plain = code ? String(code).trim() : null;
  if (plain && looksLikeCaptcha(plain)) return plain;
  if (plain) return captchaFromEncryptedField(plain);
  return null;
}

function captchaTokenFromBody(body) {
  const token = body?.data?.captcha_token
    || body?.data_optional?._data?.data?.captcha_token;
  return token ? String(token) : null;
}

async function parseJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function listenForCaptcha(page) {
  const state = { code: null, token: null };
  page.on('response', async (res) => {
    if (res.request().method() !== 'POST' || !res.url().includes('/apis')) return;
    const json = await parseJson(res);
    const code = captchaFromBody(json);
    const token = captchaTokenFromBody(json);
    if (code) state.code = code;
    if (token) {
      state.token = token;
      if (!state.code) state.code = decryptCaptchaFromJwt(token);
    }
  });
  return state;
}

async function installCaptchaHook(page) {
  await page.context().addInitScript(() => {
    window.__dmsCaptchaCode = null;
    window.__dmsCaptchaToken = null;
    const steal = (body) => {
      const code = body?.data_optional?.captcha_code
        || body?.data_optional?._data?.data_optional?.captcha_code
        || body?.data?.captcha_code;
      if (code) window.__dmsCaptchaCode = String(code).trim();
      const token = body?.data?.captcha_token
        || body?.data_optional?._data?.data?.captcha_token;
      if (token) window.__dmsCaptchaToken = String(token);
    };
    const wrapHttp = () => {
      const http = window.$http;
      if (typeof http !== 'function' || http.__dmsCaptchaWrapped) return;
      const wrapped = async (...args) => {
        const res = await http.apply(window, args);
        steal(res?.body);
        return res;
      };
      wrapped.__dmsCaptchaWrapped = true;
      window.$http = wrapped;
    };
    wrapHttp();
    const timer = setInterval(wrapHttp, 25);
    setTimeout(() => clearInterval(timer), 20000);
  });
}

async function wrapHttpForCaptcha(page) {
  await page.evaluate(() => {
    window.__dmsCaptchaCode = window.__dmsCaptchaCode || null;
    window.__dmsCaptchaToken = window.__dmsCaptchaToken || null;
    const steal = (body) => {
      const code = body?.data_optional?.captcha_code
        || body?.data_optional?._data?.data_optional?.captcha_code
        || body?.data?.captcha_code;
      if (code) window.__dmsCaptchaCode = String(code).trim();
      const token = body?.data?.captcha_token
        || body?.data_optional?._data?.data?.captcha_token;
      if (token) window.__dmsCaptchaToken = String(token);
    };
    const http = window.$http;
    if (typeof http !== 'function' || http.__dmsCaptchaWrapped) return;
    const wrapped = async (...args) => {
      const res = await http.apply(window, args);
      try { steal(res?.body); } catch { /* ignore */ }
      return res;
    };
    wrapped.__dmsCaptchaWrapped = true;
    window.$http = wrapped;
  }).catch(() => {});
}

async function envServer(page) {
  return page.evaluate(() => String(window.g?.$env_server || '')).catch(() => '');
}

async function hookedCaptchaCode(page) {
  return page.evaluate(() => window.__dmsCaptchaCode || null).catch(() => null);
}

async function hookedCaptchaToken(page) {
  return page.evaluate(() => window.__dmsCaptchaToken || null).catch(() => null);
}

async function captchaTokenFromVue(page) {
  return page.evaluate(() => {
    if (window.__dmsCaptchaToken) return window.__dmsCaptchaToken;
    const el = document.querySelector('input[placeholder="Captcha"]');
    let node = el;
    while (node) {
      const proxy = node.__vueParentComponent?.proxy;
      if (proxy?.user?.captcha_token) return proxy.user.captcha_token;
      node = node.parentElement;
    }
    return null;
  }).catch(() => null);
}

async function retrieveCaptchaFromToken(page, captcha) {
  const cfg = getEncryptionConfig();
  if (!cfg.secret_key && !loggedMissingEncrypt) {
    loggedMissingEncrypt = true;
    console.log(
      '[login] No encryption config for data_decrypt. Set DMS_CONFIG_PHP to docker/projects/config.php or DMS_DATA_SECRET_KEY.'
    );
  }
  let token = captcha.token || await hookedCaptchaToken(page) || await captchaTokenFromVue(page);
  if (!token) {
    try {
      token = await page.waitForFunction(
        () => window.__dmsCaptchaToken
          || (() => {
            const el = document.querySelector('input[placeholder="Captcha"]');
            let node = el;
            while (node) {
              const proxy = node.__vueParentComponent?.proxy;
              if (proxy?.user?.captcha_token) return proxy.user.captcha_token;
              node = node.parentElement;
            }
            return null;
          })(),
        null,
        { timeout: 5000 }
      ).then((h) => h.jsonValue());
    } catch {
      token = null;
    }
  }
  if (!token) return null;
  captcha.token = token;
  const payload = decodeJwtPayload(token);
  if (!payload?.captcha_code) {
    console.log('[login] captcha_token has no JWT captcha_code');
    return null;
  }
  const code = captchaFromEncryptedField(payload.captcha_code);
  if (code) {
    console.log('[login] Captcha from captcha_token (JWT + data_decrypt)');
  } else {
    console.log('[login] data_decrypt of JWT captcha_code failed — encryption keys may not match this host');
  }
  return code;
}

async function waitForCaptchaCode(page, timeoutMs = 3000) {
  const res = await page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'POST' || !r.ok() || !r.url().includes('/apis')) return false;
      const json = await parseJson(r);
      return Boolean(captchaFromBody(json) || captchaTokenFromBody(json));
    },
    { timeout: timeoutMs }
  );
  const json = await parseJson(res);
  return captchaFromBody(json) || decryptCaptchaFromJwt(captchaTokenFromBody(json));
}

function normalizeCaptchaText(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function preparedCaptchaImage(page) {
  return page.locator('img.captcha-img').evaluate((img) => {
    const scale = 4;
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
      const value = gray < 140 ? 0 : 255;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
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

async function ocrImageOnce(worker, image) {
  let best = null;
  for (const mode of ['7', '8', '13', '6']) {
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      tessedit_pageseg_mode: mode,
      user_defined_dpi: '300',
    });
    try {
      const { data } = await worker.recognize(image);
      const code = normalizeCaptchaText(data?.text);
      const conf = Number(data?.confidence || 0);
      if (code.length !== 5) continue;
      if (!best || conf > best.conf) best = { code, conf };
      if (conf >= 50) return best;
    } catch {
      // Tesseract "Line cannot be recognized" for a PSM mode — try the next one.
    }
  }
  return best;
}

async function ocrCaptchaImage(page, worker) {
  await page.locator('img.captcha-img').waitFor({ state: 'visible', timeout: 20000 });
  if (!worker) return null;
  const raw = await page.locator('img.captcha-img').getAttribute('src');
  const prepared = await preparedCaptchaImage(page).catch(() => null);
  const fromRaw = raw ? await ocrImageOnce(worker, raw).catch(() => null) : null;
  const fromPrep = prepared ? await ocrImageOnce(worker, prepared).catch(() => null) : null;
  const picked = [fromRaw, fromPrep]
    .filter(Boolean)
    .sort((a, b) => b.conf - a.conf)[0];
  if (picked && picked.conf >= 25) return picked.code;
  return picked?.code || null;
}

async function readCaptcha(page, captcha, worker) {
  if (!captcha.code) {
    const hooked = await hookedCaptchaCode(page);
    captcha.code = looksLikeCaptcha(hooked) ? hooked : captchaFromEncryptedField(hooked);
  }
  if (!captcha.code) {
    captcha.code = await retrieveCaptchaFromToken(page, captcha);
  }
  if (!captcha.code) {
    captcha.code = await waitForCaptchaCode(page, 800).catch(() => null);
  }
  if (captcha.code) return captcha.code;
  captcha.code = await ocrCaptchaImage(page, worker).catch(() => null);
  if (captcha.code) console.log(`[login] Captcha from image: ${captcha.code}`);
  return captcha.code;
}

async function fillCaptchaField(page, code) {
  const input = page.locator('input[placeholder="Captcha"]');
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill('');
  await input.pressSequentially(String(code), { delay: 30 });
  await input.evaluate((el, value) => {
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    native?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    let node = el;
    while (node) {
      const proxy = node.__vueParentComponent?.proxy;
      if (proxy?.user && 'captcha' in proxy.user) {
        proxy.user.captcha = value;
        break;
      }
      node = node.parentElement;
    }
  }, String(code));
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
  await installCaptchaHook(page);
  const captcha = listenForCaptcha(page);
  await page.goto('/login', { waitUntil: 'networkidle' });
  const email = page.locator('input[placeholder="Email Address"]');
  await email.waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('img.captcha-img').waitFor({ state: 'visible', timeout: 20000 });
  await wrapHttpForCaptcha(page);
  await email.fill(VALID_EMAIL);

  const env = await envServer(page);
  captcha.code = captcha.code || await hookedCaptchaCode(page);
  if (captcha.code && !looksLikeCaptcha(captcha.code)) {
    captcha.code = captchaFromEncryptedField(captcha.code);
  }
  if (!captcha.code) {
    captcha.code = await retrieveCaptchaFromToken(page, captcha);
  }
  if (captcha.code) {
    console.log(`[login] Captcha retrieved (${env || 'unknown'}): ${captcha.code}`);
  } else {
    console.log(
      `[login] ${env || 'this host'} — no data_optional.captcha_code and JWT data_decrypt failed; OCR fallback`
    );
  }

  const worker = captcha.code ? null : await createCaptchaWorker();
  const danger = page.locator('.modal-auth .alert.alert-danger');
  try {
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (attempt > 1) {
        captcha.code = null;
        captcha.token = null;
        await page.evaluate(() => {
          window.__dmsCaptchaCode = null;
          window.__dmsCaptchaToken = null;
        }).catch(() => {});
      }
      const code = await readCaptcha(page, captcha, worker);
      if (!code) {
        console.log(`[login] Captcha not retrieved (attempt ${attempt}/8) — refreshing token`);
        await refreshCaptchaImage(page);
        captcha.code = await hookedCaptchaCode(page);
        if (!captcha.code) captcha.code = await retrieveCaptchaFromToken(page, captcha);
        continue;
      }
      await fillCaptchaField(page, code);
      const img = page.locator('img.captcha-img');
      const prevSrc = await img.getAttribute('src');
      const loginBtn = page.getByRole('button', { name: /^LOGIN$/i });
      await expect(loginBtn).toBeEnabled({ timeout: 10000 });
      await loginBtn.click();
      await page.getByRole('button', { name: /Authenticating/i }).waitFor({ timeout: 4000 }).catch(() => {});

      const otpVisible = await page.locator('input.otp-digit').first()
        .waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);
      if (otpVisible) break;

      const err = (await danger.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      console.log(
        `[login] LOGIN did not accept ${code} (attempt ${attempt}/8)`
        + (err ? ` — ${err}` : ' — captcha must match JWT captcha_token after data_decrypt')
      );
      if (attempt === 8) {
        throw new Error('Could not pass captcha after 8 attempts. Confirm DMS_CONFIG_PHP / encryption keys match this host.');
      }
      const srcChanged = await expect.poll(async () => img.getAttribute('src'), { timeout: 8000 })
        .not.toBe(prevSrc)
        .then(() => true)
        .catch(() => false);
      if (!srcChanged) await refreshCaptchaImage(page);
      captcha.code = await hookedCaptchaCode(page);
      if (!captcha.code) captcha.code = await retrieveCaptchaFromToken(page, captcha);
    }
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }

  const otp = await otpForPage(page);
  console.log(`[login] OTP (${(await envServer(page)) || (isUatHost() ? 'uat' : 'dev')}): ${otp}`);
  await fillOtp(page, otp);
  await page.getByRole('button', { name: /^Submit$/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20000 });
  await page.waitForFunction(() => Boolean(localStorage.getItem('jlr_logged')), { timeout: 15000 }).catch(() => {});
}

async function refreshCaptchaImage(page) {
  const img = page.locator('img.captcha-img');
  const prevSrc = await img.getAttribute('src');
  await page.locator('.captcha-refresh').click();
  await expect.poll(async () => img.getAttribute('src'), { timeout: 8000 })
    .not.toBe(prevSrc)
    .catch(() => {});
  await page.waitForTimeout(400);
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
  dealerOtp,
  otpForPage,
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
  dataDecrypt,
  decryptCaptchaFromJwt,
};
