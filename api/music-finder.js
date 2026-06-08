// Music finder — background music via Freesound only
// Freesound API key: https://freesound.org/apiv2/apply/ (free)
// Add FREESOUND_API_KEY to .env
//
// Searches for ambient/cinematic background music tracks long enough to cover
// the video duration, downloads the HQ preview, then mixes it under the
// voiceover with automatic ducking.

if (typeof fetch === 'undefined') { require('./script-generator'); } // Node 16 polyfill

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const MUSIC_DIR = path.join(os.tmpdir(), 'vcombine_music');

function ensureDir() {
  if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

// ── Tone → search query mappings ──────────────────────────────────────────────
// These produce good results on Freesound for background/ambient tracks
const TONE_QUERIES = {
  calm:          ['ambient calm background', 'peaceful ambient music', 'soft background drone'],
  energetic:     ['upbeat background music', 'energetic ambient loop', 'driving background music'],
  educational:   ['documentary background music', 'cinematic ambient background', 'neutral ambient music'],
  inspirational: ['inspirational background music', 'uplifting ambient', 'motivational background'],
  mysterious:    ['dark ambient music', 'mysterious background drone', 'suspense ambient loop'],
  dramatic:      ['epic cinematic background', 'dramatic ambient music', 'tension background music'],
  storytelling:  ['cinematic background music', 'narrative ambient', 'storytelling background'],
  podcast:       ['subtle background music', 'soft ambient loop', 'podcast background music'],
  default:       ['ambient background music', 'background music loop', 'cinematic ambient'],
};

const FREESOUND_BASE = 'https://freesound.org/apiv2';

// ── Search Freesound for background music ─────────────────────────────────────
// minDuration: at least this many seconds (default 30 — ensures a full loop)
async function searchFreesoundMusic(query, apiKey, { limit = 6, minDuration = 30, maxDuration = 600 } = {}) {
  const params = new URLSearchParams({
    query,
    token:     apiKey,
    format:    'json',
    page_size: String(limit),
    fields:    'id,name,duration,previews,license,username,tags',
    filter:    `duration:[${minDuration} TO ${maxDuration}]`,
    sort:      'score',
  });

  const url = `${FREESOUND_BASE}/search/text/?${params}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Freesound ${r.status}: ${await r.text().catch(() => '')}`);

  const data = await r.json();
  return (data.results || []).map(s => ({
    id:          `freesound_${s.id}`,
    name:        s.name,
    artist:      s.username || '',
    duration:    s.duration,
    downloadUrl: s.previews?.['preview-hq-mp3'] || s.previews?.['preview-lq-mp3'],
    license:     s.license,
    source:      'freesound',
  })).filter(s => s.downloadUrl);
}

// ── Find best background track for a given tone/niche ────────────────────────
async function findBackgroundMusic({ tone = 'calm', niche = '', audioDuration = 60, env, logger }) {
  const apiKey = env?.FREESOUND_API_KEY || process.env.FREESOUND_API_KEY;
  if (!apiKey) {
    logger?.log?.('   ℹ️  No FREESOUND_API_KEY — skipping background music');
    return null;
  }

  ensureDir();

  // Build ordered query list: tone-specific first, then generic fallbacks
  const toneKey   = (tone || 'default').toLowerCase().replace(/[^a-z]/g, '');
  const queries   = [...(TONE_QUERIES[toneKey] || TONE_QUERIES.default), ...TONE_QUERIES.default];
  const minDur    = Math.max(30, Math.floor(audioDuration * 0.5)); // at least half video length

  logger?.log?.(`🎵 Searching Freesound for "${toneKey}" background music (min ${minDur}s)…`);

  let track = null;
  for (const query of queries) {
    if (track) break;
    try {
      const results = await searchFreesoundMusic(query, apiKey, { limit: 5, minDuration: minDur });
      if (results.length) {
        // Pick the longest result that fits (prefer tracks that cover full video)
        track = results.reduce((best, t) =>
          Math.abs(t.duration - audioDuration) < Math.abs(best.duration - audioDuration) ? t : best
        );
        logger?.log?.(`   ✅ Found: "${track.name}" by ${track.artist} (${track.duration.toFixed(0)}s)`);
      }
    } catch (e) {
      logger?.log?.(`   ⚠️  Freesound query "${query}" failed: ${e.message?.slice(0, 60)}`);
    }
  }

  if (!track) {
    logger?.log?.('   ℹ️  No suitable background track found — continuing without music');
    return null;
  }

  // Download track
  try {
    const filename = `music_${track.id}_${Date.now()}.mp3`;
    const dest     = path.join(MUSIC_DIR, filename);
    if (!fs.existsSync(dest)) {
      logger?.log?.(`   ⬇️  Downloading track…`);
      const resp = await fetch(track.downloadUrl, { signal: AbortSignal.timeout(60_000) });
      if (!resp.ok) throw new Error(`Download ${resp.status}`);
      const buf = await resp.arrayBuffer();
      fs.writeFileSync(dest, Buffer.from(buf));
      logger?.log?.(`   ✅ Downloaded (${(buf.byteLength / 1024).toFixed(0)} KB)`);
    }
    track.localPath = dest;
    return track;
  } catch (e) {
    logger?.log?.(`   ⚠️  Track download failed: ${e.message}`);
    return null;
  }
}

// ── Mix music bed under a video's audio track ─────────────────────────────────
// musicVolume: 0.0–1.0 relative — 0.12 is subtle, 0.25 is audible, 0.4 is prominent
// Voice always wins (amix weights 1.0 voice, musicVolume music)
async function mixMusicUnderVideo({ videoPath, musicPath, outputPath, musicVolume = 0.15, fadeIn = 2, fadeOut = 4, logger }) {
  // Probe video duration
  let videoDuration = 60;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
    ], { timeout: 10_000 });
    videoDuration = parseFloat(stdout.trim()) || 60;
  } catch (_) {}

  const vol      = Math.max(0.01, Math.min(1.0, musicVolume));
  const foStart  = Math.max(0, videoDuration - fadeOut);

  // Filter:
  //   1. Loop music so it always covers the video duration
  //   2. Fade music in at start, out at end
  //   3. Reduce music volume
  //   4. Normalise voice to -16 LUFS (loudness consistency)
  //   5. Mix voice (full weight) + music (reduced weight)
  const filterComplex = [
    `[1:a]aloop=loop=-1:size=2e+09,atrim=duration=${videoDuration.toFixed(3)},afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${foStart.toFixed(2)}:d=${fadeOut},volume=${vol.toFixed(3)}[music]`,
    `[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[voice]`,
    `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
  ].join(';');

  logger?.log?.(`🎛️  Mixing music at ${Math.round(vol * 100)}% under ${videoDuration.toFixed(1)}s video…`);

  await execFileAsync('ffmpeg', [
    '-y',
    '-i',          videoPath,
    '-i',          musicPath,
    '-filter_complex', filterComplex,
    '-map',        '0:v',
    '-map',        '[aout]',
    '-c:v',        'copy',
    '-c:a',        'aac',
    '-b:a',        '192k',
    '-t',          String(videoDuration.toFixed(3)),
    '-movflags',   '+faststart',
    outputPath,
  ], { timeout: 300_000 });

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('Music mix produced empty file');
  }
  logger?.log?.(`✅ Music mixed — ${(fs.statSync(outputPath).size / 1048576).toFixed(1)} MB`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function clearAllMusic(logger) {
  ensureDir();
  let count = 0, bytes = 0;
  for (const f of fs.readdirSync(MUSIC_DIR)) {
    try {
      const fp = path.join(MUSIC_DIR, f);
      bytes += fs.statSync(fp).size;
      fs.unlinkSync(fp);
      count++;
    } catch (_) {}
  }
  logger?.log?.(`🗑️  Cleared ${count} music file(s) (${(bytes / 1048576).toFixed(1)} MB)`);
  return { count, bytes };
}

module.exports = { findBackgroundMusic, mixMusicUnderVideo, clearAllMusic, MUSIC_DIR };
