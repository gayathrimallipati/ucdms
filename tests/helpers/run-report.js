const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPORT_DIR = path.join(process.cwd(), 'test-results', 'reports');
const LATEST_HTML = path.join(REPORT_DIR, 'latest.html');
const LATEST_JSON = path.join(REPORT_DIR, 'latest.json');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slug(value) {
  return String(value || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'run';
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function durationText(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function shotHref(reportFile, screenshot) {
  if (!screenshot) return '';
  try {
    return path.relative(path.dirname(reportFile), screenshot).replace(/\\/g, '/');
  } catch {
    return '';
  }
}

function renderHtml(data, reportFile) {
  const rows = data.cases.map((item, i) => {
    const href = shotHref(reportFile, item.screenshot);
    const shot = href
      ? `<a href="${escapeHtml(href)}">screenshot</a>`
      : '';
    const err = item.error
      ? `<pre>${escapeHtml(item.error)}${item.detail ? `\n${escapeHtml(item.detail)}` : ''}</pre>`
      : escapeHtml(item.detail);
    return `<tr class="${item.status}">
      <td>${i + 1}</td>
      <td>${escapeHtml(item.name)}</td>
      <td class="status">${escapeHtml(item.status)}</td>
      <td>${err}</td>
      <td>${shot}</td>
    </tr>`;
  }).join('\n');

  const notes = (data.notes || [])
    .map((n) => `<li>${escapeHtml(n)}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(data.script)} report</title>
  <style>
    body { font-family: Segoe UI, sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    .meta { color: #475569; margin-bottom: 16px; }
    .cards { display: flex; gap: 12px; margin: 16px 0 24px; flex-wrap: wrap; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; min-width: 120px; }
    .card b { display: block; font-size: 22px; }
    .ok b { color: #15803d; }
    .bad b { color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; }
    tr.passed td.status { color: #15803d; font-weight: 600; }
    tr.failed td.status { color: #b91c1c; font-weight: 600; }
    tr.failed { background: #fef2f2; }
    pre { white-space: pre-wrap; margin: 0; font-size: 12px; }
    ul { margin: 0 0 20px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(data.script)}</h1>
  <div class="meta">
    ${escapeHtml(data.host)} · ${escapeHtml(data.startedAt)} · ${escapeHtml(data.duration)}
    · ${data.failed ? 'FAILED' : 'PASSED'}
  </div>
  <div class="cards">
    <div class="card"><span>Cases</span><b>${data.cases.length}</b></div>
    <div class="card ok"><span>Passed</span><b>${data.passed}</b></div>
    <div class="card bad"><span>Failed</span><b>${data.failed}</b></div>
  </div>
  ${notes ? `<h2>Notes</h2><ul>${notes}</ul>` : ''}
  <table>
    <thead><tr><th>#</th><th>Case</th><th>Result</th><th>Details</th><th>Image</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No cases recorded.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

function openHtml(file) {
  if (process.env.CI || ['0', 'false', 'no'].includes(String(process.env.DMS_OPEN_REPORT || '').toLowerCase())) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // still printed to the console
  }
}

function writeReport(data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const fileName = `${stamp(new Date(data.startedAt))}-${slug(data.script)}.html`;
  const htmlPath = path.join(REPORT_DIR, fileName);
  const jsonPath = htmlPath.replace(/\.html$/, '.json');
  const html = renderHtml(data, htmlPath);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  fs.writeFileSync(LATEST_HTML, html);
  fs.writeFileSync(LATEST_JSON, JSON.stringify({ ...data, htmlPath }, null, 2));
  return { htmlPath, jsonPath, latestHtml: LATEST_HTML };
}

function printSummary(data, paths) {
  const line = data.failed
    ? `[report] ${data.failed} failed, ${data.passed} passed`
    : `[report] ${data.passed} passed`;
  console.log(`\n========== REPORT ==========`);
  console.log(`${line} · ${data.duration}`);
  console.log(`[report] ${paths.htmlPath}`);
  console.log(`[report] ${paths.latestHtml}`);
  console.log(`============================\n`);
}

function createRunReport(scriptName) {
  const startedAt = new Date();
  const cases = [];
  const notes = [];
  let finished = false;

  function record(entry) {
    cases.push({
      name: entry.name,
      status: entry.status,
      error: entry.error || '',
      detail: entry.detail || '',
      screenshot: entry.screenshot || '',
      at: new Date().toISOString(),
    });
  }

  const report = {
    pass(name, detail = '', screenshot = '') {
      record({ name, status: 'passed', detail, screenshot });
    },
    fail(name, error, screenshot = '') {
      const err = error && error.message ? error.message : String(error || 'failed');
      const detail = error && error.stack
        ? String(error.stack).split('\n').slice(1, 6).join('\n')
        : '';
      record({ name, status: 'failed', error: err, detail, screenshot });
    },
    note(text) {
      if (text) notes.push(String(text));
    },
    async step(name, fn, page) {
      try {
        const result = await fn();
        const detail = result && (result.leadId || result.stockId)
          ? [result.leadId, result.stockId].filter(Boolean).join(' / ')
          : '';
        report.pass(name, detail);
        return result;
      } catch (err) {
        let screenshot = '';
        if (page && typeof page.screenshot === 'function') {
          try {
            const dir = path.join(process.cwd(), 'test-results', 'failed-cases');
            fs.mkdirSync(dir, { recursive: true });
            screenshot = path.join(dir, `${slug(name)}-${Date.now()}.png`);
            await page.screenshot({ path: screenshot, fullPage: true });
          } catch {
            screenshot = '';
          }
        }
        report.fail(name, err, screenshot);
        throw err;
      }
    },
    finish(extra = {}) {
      if (finished) return extra.htmlPath;
      finished = true;
      if (extra.error && !cases.some((c) => c.status === 'failed')) {
        report.fail('Run aborted', extra.error);
      }
      delete extra.error;
      const passed = cases.filter((c) => c.status === 'passed').length;
      const failed = cases.filter((c) => c.status === 'failed').length;
      const data = {
        script: scriptName,
        host: process.env.DMS_URL || 'https://dms.jlr.local',
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        duration: durationText(Date.now() - startedAt.getTime()),
        passed,
        failed,
        cases,
        notes,
        extra,
        result: failed ? 'failed' : 'passed',
      };
      const paths = writeReport(data);
      printSummary(data, paths);
      openHtml(paths.latestHtml);
      return paths.htmlPath;
    },
  };

  return report;
}

function openLatest() {
  if (!fs.existsSync(LATEST_HTML)) {
    console.error('[report] No report yet. Run a script first (npm test, npm run test:add, …).');
    process.exitCode = 1;
    return;
  }
  console.log(`[report] ${LATEST_HTML}`);
  openHtml(LATEST_HTML);
}

module.exports = {
  REPORT_DIR,
  LATEST_HTML,
  createRunReport,
  openLatest,
};
