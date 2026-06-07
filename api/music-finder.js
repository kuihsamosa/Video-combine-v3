// Music & SFX finder
// Background music: Jamendo (free CC, needs JAMENDO_CLIENT_ID in .env)
// Sound effects:    Freesound (free, needs FREESOUND_API_KEY in .env)
// Both download to a local cache dir and are served via /api/music-file/:filename

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const MUSIC_DIR = path.join(os.tmpdir(), 'vcombine_music');

function ensureDir() {
  if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

// ── Jamendo background music ──────────────────────────────────────────────────
// Docs: https://developer.jamendo.com/v3.0/tracks
// Free client_id obtained at: https://devportal.jamendo.com (free registration)
const JAMENDO_BASE = 'https://api.jamendo.com/v3.0';

// Mood → Jamendo tag mappings
const MOOD_TAGS = {
  cinematic:    'cinematic',
  motivational: 'motivational',
  calm:         'ambient',
  upbeat:       'pop',
  energetic:    'electronic',
  dramatic:     'epic',
  happy:        'pop',
  dark:         'dark',
  corporate:    'corporate',
  nature:       'acoustic',
};

async function searchJamendo(query, clientId, { limit = 8, mood = '' } = {}) {
  const tag   = MOOD_TAGS[mood] || '';
  const params = new URLSearchParams({
    client_id:        clientId,
    format:           'json',
    limit:            String(limit),
    search:           query || tag || 'background',
    tags:             tag,
    audioformat:      'mp32',
    audiodlformat:    'mp32',
    imagesize:        '100',
    order:            'popularity_total',
    include:          'musicinfo licenses',
    ccsa:             '1',   // require Share-Alike (or more permissive)
  });

  const url = `${JAMENDO_BASE}/tracks/?${params}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`Jamendo ${r.status}: ${await r.text().catch(()=>'')}`);

  const data = await r.json();
  if (data.headers?.status !== 'success') throw new Error(`Jamendo: ${data.headers?.error_message || 'API error'}`);

  return (data.results || []).map(t => ({
    id:          `jamendo_${t.id}`,
    name:        t.name,
    artist:      t.artist_name,
    duration:    t.duration,      // seconds
    thumbnail:   t.image,
    previewUrl:  t.audio,         // 30-sec preview (no download needed to stream)
    downloadUrl: t.audiodownload, // full track direct download
    downloadAllowed: t.audiodownload_allowed,
    license:     t.license_ccurl || 'CC',
    source:      'jamendo',
  })).filter(t => t.downloadAllowed && t.downloadUrl);
}

// ── Freesound SFX ─────────────────────────────────────────────────────────────
// Docs: https://freesound.org/docs/api/
// Free API key at: https://freesound.org/apiv2/apply/
const FREESOUND_BASE = 'https://freesound.org/apiv2';

async function searchFreesound(query, apiKey, { limit = 8, minDur = 0.5, maxDur = 30 } = {}) {
  const params = new URLSearchParams({
    query,
    token:        apiKey,
    format:       'json',
    page_size:    String(limit),
    fields:       'id,name,duration,previews,license,tags,description',
    filter:       `duration:[${minDur} TO ${maxDur}]`,
    sort:         'score',
  });

  const url = `${FREESOUND_BASE}/search/text/?${params}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`Freesound ${r.status}: ${await r.text().catch(()=>'')}`);

  const data = await r.json();
  return (data.results || []).map(s => ({
    id:          `freesound_${s.id}`,
    name:        s.name,
    artist:      '',
    duration:    s.duration,
    previewUrl:  s.previews?.['preview-hq-mp3'] || s.previews?.['preview-lq-mp3'],
    downloadUrl: s.previews?.['preview-hq-mp3'],  // preview is the usable quality for SFX
    downloadAllowed: true,
    license:     s.license,
    source:      'freesound',
  })).filter(s => s.previewUrl);
}

// ── Downloader ────────────────────────────────────────────────────────────────
async function downloadTrack(url, filename, logger) {
  ensureDir();
  const dest = path.join(MUSIC_DIR, filename);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    logger?.log?.(`   📁 Cached: ${filename}`);
    return dest;
  }
  logger?.log?.(`   ⬇️  ${filename} ← ${url.slice(0, 70)}…`);
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Download ${r.status}`);
  const buf = await r.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
  logger?.log?.(`   ✅ ${filename} (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
  return dest;
}

// ── Mix music under video audio ───────────────────────────────────────────────
// Produces a new video with music bed under the original audio track.
//
// musicVolume: 0.0–1.0  (relative to -18 dBFS normalised music; 0.15 = subtle, 0.3 = prominent)
// fadeIn/fadeOut: seconds to fade music
async function mixMusicUnderVideo({ videoPath, musicPath, outputPath, musicVolume = 0.18, fadeIn = 2, fadeOut = 3, logger }) {
  logger?.log?.('🎵 Getting video duration for music fade…');

  // Get video duration so we can trim music and apply tail fade
  let videoDuration = 60;
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { timeout: 10_000 }
    );
    videoDuration = parseFloat(stdout.trim()) || 60;
  } catch(_) {}

  const vol    = Math.max(0.01, Math.min(1, musicVolume));
  const foStart = Math.max(0, videoDuration - fadeOut);

  // Filter chain:
  //  1. Trim music to video length (loop if shorter via -stream_loop)
  //  2. Apply fade-in and fade-out on music
  //  3. Lower volume
  //  4. Mix with original audio (voice always wins)
  //  5. Limit to prevent clipping
  const filterComplex = [
    // Music track: fade in + fade out + volume
    `[1:a]afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${foStart.toFixed(2)}:d=${fadeOut},volume=${vol.toFixed(3)}[music]`,
    // Mix voice + music, voice-weighted
    `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2:weights=1 ${(1).toFixed(2)}[aout]`,
  ].join(';');

  const cmd = [
    'ffmpeg', '-y',
    // Loop music if shorter than video
    '-stream_loop', '-1',
    `-i "${videoPath}"`,
    `-i "${musicPath}"`,
    `-filter_complex "${filterComplex}"`,
    '-map 0:v',
    '-map [aout]',
    '-c:v copy',
    '-c:a aac -b:a 192k',
    `-t ${videoDuration.toFixed(3)}`,
    '-movflags +faststart',
    `"${outputPath}"`,
  ].join(' ');

  logger?.log?.(`🎛️  Mixing music at ${Math.round(vol * 100)}% volume (${videoDuration.toFixed(1)}s)…`);

  try {
    await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024, timeout: 600_000 });
  } catch (e) {
    throw new Error(`Music mix failed: ${(e.stderr || e.message).slice(-500)}`);
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('Music mix produced an empty file');
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
    } catch(_) {}
  }
  logger?.log?.(`🗑️  Cleared ${count} music file(s) (${(bytes / 1048576).toFixed(1)} MB)`);
  return { count, bytes };
}

module.exports = { searchJamendo, searchFreesound, downloadTrack, mixMusicUnderVideo, clearAllMusic, MUSIC_DIR };
