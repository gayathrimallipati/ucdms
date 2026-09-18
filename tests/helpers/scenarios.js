const { expect } = require('@playwright/test');
const {
  VALID_EMAIL,
  VALID_OTP,
  UNKNOWN_EMAIL,
  listenForCaptcha,
  readCaptcha,
  fillOtp,
  clearOtp,
  saveFailedLoginShot,
  formError,
  toast,
} = require('./login');
const { runPmAddScenarios } = require('./pm-add-scenarios');

/**
 * Runs every login scenario on the same page.
 * Opens /login once. Does not create another browser or tab.
 */
async function runLoginScenarios(page, testInfo) {
  const failures = [];
  const captcha = listenForCaptcha(page);

  async function scenario(name, fn, { loginFailed = false } = {}) {
    process.stdout.write(`\n→ ${name}\n`);
    try {
      await fn();
      if (loginFailed) await saveFailedLoginShot(page, testInfo, name);
      console.log(`  ok`);
    } catch (err) {
      await saveFailedLoginShot(page, testInfo, `unexpected-${name}`).catch(() => {});
      failures.push(`${name}: ${err.message}`);
      console.log(`  FAIL: ${err.message}`);
    }
  }

  await page.goto('/login', { waitUntil: 'networkidle' });
  await expect(page.locator('input[placeholder="Email Address"]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('img.captcha-img')).toBeVisible({ timeout: 20000 });
  if (!captcha.code) captcha.code = await readCaptcha(page, captcha).catch(() => captcha.code);

  const email = page.locator('input[placeholder="Email Address"]');
  const captchaInput = page.locator('input[placeholder="Captcha"]');
  const loginBtn = page.getByRole('button', { name: /^LOGIN$/i });

  await scenario('form shows email, captcha, remember me, LOGIN', async () => {
    await expect(email).toBeVisible();
    await expect(captchaInput).toBeVisible();
    await expect(page.locator('img.captcha-img')).toBeVisible();
    await expect(page.locator('#remember_me')).toBeVisible();
    await expect(loginBtn).toBeEnabled();
    await expect(page.locator('input.otp-digit')).toHaveCount(0);
  });

  await scenario('remember me can be toggled', async () => {
    const box = page.locator('#remember_me');
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(box).not.toBeChecked();
  });

  await scenario('empty form is rejected', async () => {
    await loginBtn.click();
    await expect(formError(page)).toContainText('Enter valid email address.');
    await expect(page.locator('input.otp-digit')).toHaveCount(0);
  }, { loginFailed: true });

  await scenario('invalid email format is rejected', async () => {
    await email.fill('not-an-email');
    await captchaInput.fill(await readCaptcha(page, captcha));
    await loginBtn.click();
    await expect(formError(page)).toContainText('Enter valid email address.');
    await expect(page.locator('input.otp-digit')).toHaveCount(0);
  }, { loginFailed: true });

  await scenario('email missing domain is rejected', async () => {
    await email.fill('dealer@');
    await captchaInput.fill(await readCaptcha(page, captcha));
    await loginBtn.click();
    await expect(formError(page)).toContainText('Enter valid email address.');
  }, { loginFailed: true });

  await scenario('typed email is converted to lowercase', async () => {
    await email.fill('Dealer@CarTrade.COM');
    await email.blur();
    await expect(email).toHaveValue('dealer@cartrade.com');
  });

  await scenario('valid email and empty captcha is rejected', async () => {
    await email.fill(VALID_EMAIL);
    await captchaInput.fill('');
    await loginBtn.click();
    await expect(formError(page)).toContainText('Enter captcha.');
    await expect(page.locator('input.otp-digit')).toHaveCount(0);
  }, { loginFailed: true });

  await scenario('captcha typing rejects special characters', async () => {
    await captchaInput.fill('');
    await captchaInput.click();
    await page.keyboard.type('AB@#$12');
    await expect(captchaInput).toHaveValue('AB12');
  });

  await scenario('refresh replaces captcha and clears the field', async () => {
    const img = page.locator('img.captcha-img');
    const beforeSrc = await img.getAttribute('src');
    const beforeCode = captcha.code;
    await captchaInput.fill('ABC12');
    await page.locator('.captcha-refresh').click();
    await expect.poll(async () => img.getAttribute('src'), { timeout: 15000 }).not.toBe(beforeSrc);
    await expect(captchaInput).toHaveValue('');
    await expect.poll(() => captcha.code, { timeout: 15000 }).not.toBe(beforeCode);
  });

  await scenario('wrong captcha stays on step 1', async () => {
    await email.fill(VALID_EMAIL);
    await captchaInput.fill('XXXXX');
    await loginBtn.click();
    await expect(loginBtn).toBeVisible({ timeout: 15000 });
    await expect(page.locator('input.otp-digit')).toHaveCount(0);
    await expect(captchaInput).toHaveValue('');
  }, { loginFailed: true });

  await scenario('unknown email still moves to OTP step', async () => {
    await email.fill(UNKNOWN_EMAIL);
    await captchaInput.fill(await readCaptcha(page, captcha));
    await loginBtn.click();
    await expect(page.locator('input.otp-digit').first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /^Submit$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Back$/i })).toBeVisible();
    await page.getByRole('button', { name: /^Back$/i }).click();
    await expect(loginBtn).toBeVisible();
  });

  await scenario('registered email with valid captcha shows OTP and timer', async () => {
    await email.fill(VALID_EMAIL);
    await captchaInput.fill(await readCaptcha(page, captcha));
    await loginBtn.click();
    await expect(page.locator('input.otp-digit')).toHaveCount(6, { timeout: 15000 });
    await expect(loginBtn).toHaveCount(0);
    await expect(page.locator('.small.text-muted')).toContainText(/Resend OTP in \d+s/);
    await expect(toast(page)).toContainText(/OTP/i, { timeout: 5000 });
  });

  await scenario('empty OTP is rejected', async () => {
    await clearOtp(page);
    await page.getByRole('button', { name: /^Submit$/i }).click();
    await expect(formError(page)).toContainText('Enter valid 6-digit OTP.');
    await expect(page).toHaveURL(/\/login/);
  }, { loginFailed: true });

  await scenario('partial OTP is rejected', async () => {
    await fillOtp(page, '123');
    await page.getByRole('button', { name: /^Submit$/i }).click();
    await expect(formError(page)).toContainText('Enter valid 6-digit OTP.');
    await expect(page).toHaveURL(/\/login/);
  }, { loginFailed: true });

  await scenario('OTP boxes reject letters', async () => {
    await clearOtp(page);
    const first = page.locator('input.otp-digit').first();
    await first.click();
    await page.keyboard.type('A9B');
    await expect(first).toHaveValue('9');
  });

  await scenario('pasting 6 digits fills all OTP boxes', async () => {
    await clearOtp(page);
    await page.locator('input.otp-digit').first().click();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text', '123456');
      document.querySelector('input.otp-digit').dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    });
    await expect.poll(async () => (
      page.locator('input.otp-digit').evaluateAll((els) => els.map((el) => el.value).join(''))
    )).toBe('123456');
  });

  await scenario('wrong OTP stays on OTP step', async () => {
    await fillOtp(page, '000000');
    await page.getByRole('button', { name: /^Submit$/i }).click();
    await expect(toast(page)).toContainText(/OTP|failed|invalid/i, { timeout: 15000 });
    await expect(page.locator('input.otp-digit').first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  }, { loginFailed: true });

  await scenario('valid OTP reaches dashboard', async () => {
    await fillOtp(page, VALID_OTP);
    await page.getByRole('button', { name: /^Submit$/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20000 });
    await expect(page).not.toHaveURL(/\/login$/);
    await expect(page).toHaveURL(/\/dashboard|\/home|\/stock|\/leads|\/purchase-master/i);
  });

  const addResult = await runPmAddScenarios(page, testInfo);
  failures.push(...(addResult.failures || []));

  return failures;
}

module.exports = { runLoginScenarios };
