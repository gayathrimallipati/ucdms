const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { AUTH_STATE_PATH, hasSavedDealerSession, sessionMatchesCurrentHost } = require('./login');

function loadEnvFile() {
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
}

loadEnvFile();

function isHeadless() {
  const v = String(process.env.DMS_HEADLESS || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function browserAttempts() {
  const requested = String(process.env.DMS_BROWSER || '').trim().toLowerCase();
  if (requested) return [requested];
  return ['chrome', 'msedge', 'chromium'];
}

/**
 * Launch a visible browser on any machine:
 * system Chrome, then Edge, then Playwright Chromium.
 */
async function launchBrowser() {
  const headless = isHeadless();
  const args = ['--ignore-certificate-errors', '--ignore-certificate-errors-spki-list'];
  let lastError;

  for (const name of browserAttempts()) {
    try {
      const options = name === 'chromium'
        ? { headless, args }
        : { headless, channel: name, args };
      const browser = await chromium.launch(options);
      console.log(`[agent] Browser: ${name}${headless ? ' (headless)' : ''}`);
      return browser;
    } catch (err) {
      lastError = err;
      console.log(`[agent] ${name} not available (${err.message.split('\n')[0]})`);
    }
  }

  throw new Error(
    [
      'Could not open a browser on this machine.',
      'Install Google Chrome or Microsoft Edge, or run:',
      '  npx playwright install chromium',
      lastError ? `Last error: ${lastError.message}` : '',
    ].filter(Boolean).join('\n')
  );
}

function baseURL() {
  return process.env.DMS_URL || 'https://dms.jlr.local';
}

async function newAppContext(browser, options = {}) {
  const reuseSession = options.reuseSession === true
    && hasSavedDealerSession()
    && sessionMatchesCurrentHost();
  return browser.newContext({
    baseURL: baseURL(),
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 },
    ...(reuseSession ? { storageState: AUTH_STATE_PATH } : {}),
  });
}

module.exports = {
  loadEnvFile,
  launchBrowser,
  newAppContext,
  baseURL,
  isHeadless,
};
