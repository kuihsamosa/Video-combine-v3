// YouTube clip downloader — wraps yt-dlp CLI
// Downloads a YouTube URL to a temp file, serves it via a /api/youtube-file/:id route.
// Designed to produce footage clips for the auto video pipeline.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const YT_DIR = path.join(os.tmpdir(), 'vcombine_yt');
// Lazy-load auth to avoid circular deps
function getCookiePath() {
  try { return require('./youtube-auth').COOKIE_PATH; } catch (_) { return null; }
}
function hasCookies() {
  try { return require('./youtube-auth').cookiesExist(); } catch (_) { return false; }
}

function ensureDir() {
  if (!fs.existsSync(YT_DIR)) fs.mkdirSync(YT_DIR, { recursive: true });
}

// Find yt-dlp binary — prefer system install, fall back to Python module
function ytDlpBin() {
  const candidates = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Try PATH via which
  try {
    const r = execFileSync('which', ['yt-dlp'], { timeout: 3000 }).toString().trim();
    if (r) return r;
  } catch (_) {}
  return 'yt-dlp'; // hope it's on PATH
}

const YT_DLP = ytDlpBin();

// ── Fetch video metadata (title, duration, thumbnail) without downloading ─────
async function getYouTubeInfo(url, logger) {
  logger?.log?.(`🔍 Fetching info: ${url}`);
  const { stdout } = await execFileAsync(YT_DLP, [
    '--dump-json',
    '--no-playlist',
    '--quiet',
    url,
  ], { timeout: 30_000 });

  const info = JSON.parse(stdout.trim());
  return {
    title:     info.title     || 'Unknown',
    duration:  info.duration  || 0,   // seconds
    thumbnail: info.thumbnail || (info.thumbnails?.[0]?.url) || '',
    uploader:  info.uploader  || '',
    url,
  };
}

// ── Download a YouTube URL to YT_DIR ─────────────────────────────────────────
// Returns { filePath, filename, title, duration, thumbnail }
// quality: 'best'|'720'|'1080'|'480'
async function downloadYouTube(url, { quality = '1080', logger } = {}) {
  ensureDir();

  // Build format selector — best video up to target height + best audio, merged to mp4
  const fmtMap = {
    'best': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
    '1080': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '720':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
    '480':  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
  };
  const fmt = fmtMap[quality] || fmtMap['1080'];

  // Use a unique output template so concurrent downloads don't collide
  const uid  = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const tmpl = path.join(YT_DIR, `yt_${uid}.%(ext)s`);

  logger?.log?.(`⬇️  Downloading YouTube clip (${quality}p)…`);

  const args = [
    '--format', fmt,
    '--merge-output-format', 'mp4',
    '--output', tmpl,
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    '--no-progress',
  ];

  // Use saved cookies if available (allows age-restricted / member-only content)
  if (hasCookies()) {
    const cp = getCookiePath();
    if (cp) { args.push('--cookies', cp); logger?.log?.('🔑 Using saved YouTube cookies'); }
  }

  args.push(url);

  try {
    await execFileAsync(YT_DLP, args, { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`yt-dlp failed: ${(e.stderr || e.message || '').slice(0, 400)}`);
  }

  // Find output file (template expands ext)
  const files = fs.readdirSync(YT_DIR)
    .filter(f => f.startsWith(`yt_${uid}`) && f.endsWith('.mp4'));

  if (!files.length) throw new Error('yt-dlp produced no output file');

  const filename = files[0];
  const filePath = path.join(YT_DIR, filename);
  const size = fs.statSync(filePath).size;
  logger?.log?.(`✅ Downloaded: ${filename} (${(size / 1048576).toFixed(1)} MB)`);

  return { filePath, filename };
}

// ── List cached YT files ──────────────────────────────────────────────────────
function listYouTubeFiles() {
  ensureDir();
  return fs.readdirSync(YT_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({
      filename: f,
      size: fs.statSync(path.join(YT_DIR, f)).size,
      mtime: fs.statSync(path.join(YT_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

// ── Clear cache ───────────────────────────────────────────────────────────────
function clearYouTubeCache(logger) {
  ensureDir();
  let count = 0, bytes = 0;
  for (const f of fs.readdirSync(YT_DIR)) {
    try {
      const fp = path.join(YT_DIR, f);
      bytes += fs.statSync(fp).size;
      fs.unlinkSync(fp);
      count++;
    } catch (_) {}
  }
  logger?.log?.(`🗑️  Cleared ${count} YouTube file(s) (${(bytes / 1048576).toFixed(1)} MB)`);
  return { count, bytes };
}

module.exports = { getYouTubeInfo, downloadYouTube, listYouTubeFiles, clearYouTubeCache, YT_DIR };
