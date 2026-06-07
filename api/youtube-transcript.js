// YouTube Transcript Fetcher + Scene Matcher
// Fetches auto-generated subtitles via yt-dlp info dump, parses the VTT content,
// then scores each time window against a scene description to find the best timestamp.
// Used by footage-finder.js to extract relevant segments instead of always taking t=0.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// Node 16 compatibility
if (typeof fetch === 'undefined') { require('./script-generator'); }

const YT_DLP = (() => {
  for (const c of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp';
})();

// ── VTT parser ─────────────────────────────────────────────────────────────────
// Parses WebVTT text into [{start, end, text}] cues.
// Handles both standard VTT timestamps and YouTube's extended format.
function parseVtt(vttText) {
  const cues = [];
  // Match timestamp lines: 00:00:01.000 --> 00:00:03.000
  const cuePattern = /(\d{1,2}:\d{2}:\d{2}[\.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[\.,]\d{3})[^\n]*\n([\s\S]*?)(?=\n\d{1,2}:\d{2}|\n\n|$)/g;
  let m;
  while ((m = cuePattern.exec(vttText)) !== null) {
    const start = parseTimestamp(m[1]);
    const end   = parseTimestamp(m[2]);
    const text  = m[3]
      .replace(/<[^>]*>/g, '')      // strip inline tags e.g. <c>word</c>
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n/g, ' ')
      .trim();
    if (text && end > start) cues.push({ start, end, text });
  }
  return cues;
}

// "0:01:23.456" or "00:01:23,456" → seconds float
function parseTimestamp(ts) {
  const clean = ts.replace(',', '.');
  const parts = clean.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

// Format seconds → "H:MM:SS" for yt-dlp --download-sections
function fmtSecs(s) {
  const secs = Math.max(0, Math.floor(s));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

// ── Fetch VTT from yt-dlp info dump ──────────────────────────────────────────
// Strategy:
//   1. yt-dlp --dump-json gives us the subtitle URL embedded in the JSON
//   2. We fetch the M3U8 manifest (single request, not rate-limited the same way)
//   3. Extract the actual timedtext URL from the manifest
//   4. Fetch the VTT text
// Falls back gracefully if any step fails.
async function fetchTranscript(ytUrl, logger) {
  const log = (msg) => logger?.log?.(msg);

  try {
    log(`📝 Fetching transcript for: ${ytUrl}`);

    // Step 1: get info JSON (fast, no video download)
    const cookieArgs = [];
    try {
      const { cookiesExist, COOKIE_PATH } = require('./youtube-auth');
      if (cookiesExist()) cookieArgs.push('--cookies', COOKIE_PATH);
      else {
        // Try browser cookies silently
        cookieArgs.push('--cookies-from-browser', 'chrome');
      }
    } catch (_) {}

    let infoJson;
    try {
      const { stdout } = await execFileAsync(YT_DLP, [
        '--dump-json', '--no-download', '--quiet', '--no-warnings',
        ...cookieArgs,
        ytUrl,
      ], { timeout: 30_000 });
      infoJson = JSON.parse(stdout.trim());
    } catch (e) {
      log(`   ⚠️  Transcript info fetch failed: ${e.message?.slice(0, 80)}`);
      return null;
    }

    // Step 2: find a subtitle URL (prefer automatic_captions in English)
    const autoCaps = infoJson?.automatic_captions || {};
    const manualSubs = infoJson?.subtitles || {};

    // Pick English caption entry
    const enKey = Object.keys(autoCaps).find(k => k === 'en' || k.startsWith('en-')) ||
                  Object.keys(manualSubs).find(k => k === 'en' || k.startsWith('en-'));

    const entries = enKey ? (autoCaps[enKey] || manualSubs[enKey] || []) : [];
    const vttEntry = entries.find(e => e.ext === 'vtt' || e.ext === 'json3') || entries[0];

    if (!vttEntry?.url) {
      log(`   ℹ️  No transcript available for this video`);
      return null;
    }

    // Step 3: fetch M3U8 manifest to get the actual VTT segment URL
    let vttText = null;

    try {
      const m3u8Resp = await fetch(vttEntry.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!m3u8Resp.ok) throw new Error(`M3U8 ${m3u8Resp.status}`);

      const m3u8Text = await m3u8Resp.text();

      if (m3u8Text.startsWith('WEBVTT') || m3u8Text.includes('-->')) {
        // Direct VTT, not a manifest
        vttText = m3u8Text;
      } else {
        // It's an M3U8 — extract the segment URLs and fetch each
        const segUrls = m3u8Text.split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('https://'));

        const parts = [];
        for (const segUrl of segUrls) {
          try {
            const r = await fetch(segUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
              signal: AbortSignal.timeout(15_000),
            });
            if (r.ok) parts.push(await r.text());
          } catch (_) {}
        }
        vttText = parts.join('\n');
      }
    } catch (e) {
      log(`   ⚠️  Transcript fetch failed: ${e.message?.slice(0, 80)}`);
      return null;
    }

    if (!vttText || !vttText.includes('-->')) {
      log(`   ℹ️  Transcript empty or unreadable`);
      return null;
    }

    const cues = parseVtt(vttText);
    log(`   ✅ Transcript: ${cues.length} cue(s), ${cues.at(-1)?.end?.toFixed(0) || '?'}s`);
    return cues; // [{start, end, text}, ...]

  } catch (e) {
    log(`   ⚠️  Transcript error: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

// ── Scene → timestamp matcher ─────────────────────────────────────────────────
// Scores every 30-second window of the transcript against the scene's description
// and keywords using simple term frequency.
// Returns the best matching start time in seconds (or null if no transcript).

function matchSceneToTimestamp(cues, scene, windowSecs = 30) {
  if (!cues || cues.length === 0) return null;

  const totalDuration = cues.at(-1)?.end || 0;
  if (totalDuration < 5) return null;

  // Build query term set from scene
  const description = (scene.description || '').toLowerCase();
  const keywords    = (scene.visual_keywords || []).join(' ').toLowerCase();
  const queries     = (scene.search_queries  || []).join(' ').toLowerCase();
  const rawTerms    = `${description} ${keywords} ${queries}`;

  // Tokenize — remove stop words, keep meaningful terms (3+ chars)
  const STOP = new Set(['the','and','for','are','was','were','with','this','that',
    'from','they','have','had','has','but','not','what','all','been','when',
    'will','would','could','should','their','there','which','about','into',
    'more','also','than','then','its','your','our','these','those','some',
    'can','just','over','like','time','very','only','said','each','well']);

  const queryTerms = [...new Set(
    rawTerms.split(/\W+/).filter(t => t.length >= 3 && !STOP.has(t))
  )];

  if (!queryTerms.length) return null;

  // Slide a window through the cues
  let bestScore = -1;
  let bestStart = 0;
  const step = Math.max(5, windowSecs / 4);  // stride = windowSecs/4

  for (let t = 0; t < totalDuration - windowSecs / 2; t += step) {
    const windowEnd  = t + windowSecs;
    const windowText = cues
      .filter(c => c.start >= t && c.start < windowEnd)
      .map(c => c.text)
      .join(' ')
      .toLowerCase();

    if (!windowText.trim()) continue;

    // Score: sum of (occurrences of each query term) weighted by term rarity
    let score = 0;
    for (const term of queryTerms) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
      const count = (windowText.match(re) || []).length;
      if (count > 0) score += 1 + Math.log(count); // log-weighted
    }

    if (score > bestScore) {
      bestScore = score;
      bestStart = t;
    }
  }

  // If best score is too low (< 0.5), the transcript probably doesn't match at all
  // Return the best we found anyway — it's still better than t=0
  return bestScore > 0 ? bestStart : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Given a YouTube URL and a scene object, find the best timestamp to extract.
 * Returns a number (seconds) or null if transcript unavailable.
 */
async function findSceneTimestamp(ytUrl, scene, logger) {
  const cues = await fetchTranscript(ytUrl, logger);
  if (!cues) return null;
  const ts = matchSceneToTimestamp(cues, scene);
  if (ts !== null) {
    logger?.log?.(`   🎯 Best scene match: ${fmtSecs(ts)} (score-based)`);
  }
  return ts;
}

module.exports = { fetchTranscript, matchSceneToTimestamp, findSceneTimestamp, parseVtt, fmtSecs };
