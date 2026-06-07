// YouTube authentication — opens the user's real browser for login,
// then captures cookies via yt-dlp --cookies-from-browser.
// No Selenium involved (Google blocks automated browsers).

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const COOKIE_PATH = path.join(os.tmpdir(), 'vcombine_yt_cookies.txt');

const YT_DLP = (() => {
  for (const c of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp';
})();

// Priority order — yt-dlp supports all of these
const BROWSER_PRIORITY = ['vivaldi', 'firefox', 'safari', 'chrome', 'brave', 'edge'];

// ── Cookie status ─────────────────────────────────────────────────────────────
function cookiesExist() {
  if (!fs.existsSync(COOKIE_PATH)) return false;
  const txt = fs.readFileSync(COOKIE_PATH, 'utf8');
  return (txt.includes('.youtube.com') || txt.includes('.google.com')) &&
         txt.split('\n').filter(l => l && !l.startsWith('#')).length > 3;
}

function cookieStatus() {
  if (!cookiesExist()) return { exists: false };
  const stat = fs.statSync(COOKIE_PATH);
  const ageH = (Date.now() - stat.mtimeMs) / 3_600_000;
  return { exists: true, ageh: Math.round(ageH * 10) / 10, stale: ageH > 48 };
}

function clearCookies() {
  try { fs.unlinkSync(COOKIE_PATH); } catch (_) {}
  return { ok: true };
}

// ── Open the real browser so the user can sign in ─────────────────────────────
// Returns immediately — browser stays open, user signs in normally.
function openRealBrowser(browser = 'auto') {
  const url = 'https://www.youtube.com';

  const appMap = {
    vivaldi: '/Applications/Vivaldi.app',
    firefox: '/Applications/Firefox.app',
    safari:  '/Applications/Safari.app',
    chrome:  '/Applications/Google Chrome.app',
    brave:   '/Applications/Brave Browser.app',
  };

  // Find which app to open
  let appPath = null;
  if (browser !== 'auto' && appMap[browser] && fs.existsSync(appMap[browser])) {
    appPath = appMap[browser];
  } else {
    for (const [, p] of Object.entries(appMap)) {
      if (fs.existsSync(p)) { appPath = p; break; }
    }
  }

  const args = appPath ? ['-a', appPath, url] : [url];
  execFile('open', args, { timeout: 8000 }, () => {});

  const name = appPath ? path.basename(appPath, '.app') : 'your browser';
  return { ok: true, browser: name };
}

// ── Extract cookies from the user's logged-in browser ────────────────────────
// Tries each browser in priority order until one works.
async function extractFromBrowser(preferredBrowser, logger) {
  const order = preferredBrowser && preferredBrowser !== 'auto'
    ? [preferredBrowser, ...BROWSER_PRIORITY.filter(b => b !== preferredBrowser)]
    : BROWSER_PRIORITY;

  for (const browser of order) {
    logger?.log?.(`🍪 Trying ${browser}…`);
    try {
      await execFileAsync(YT_DLP, [
        '--cookies-from-browser', browser,
        '--cookies', COOKIE_PATH,
        '--skip-download', '--quiet', '--no-warnings',
        'https://www.youtube.com',
      ], { timeout: 30_000 });

      if (cookiesExist()) {
        logger?.log?.(`✅ Cookies captured from ${browser}`);
        return { ok: true, browser };
      }
    } catch (e) {
      const msg = (e.stderr || e.message || '').slice(0, 120);
      logger?.log?.(`   ⚠️  ${browser}: ${msg}`);
    }
  }

  return {
    ok: false,
    error: 'Could not find YouTube cookies in any browser. Make sure you are signed in to YouTube in Vivaldi or Firefox, then try again.',
  };
}

module.exports = {
  openRealBrowser,
  extractFromBrowser,
  cookiesExist,
  cookieStatus,
  clearCookies,
  COOKIE_PATH,
};
