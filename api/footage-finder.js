// Footage Finder — queries Pexels, Pixabay, AND YouTube in parallel per scene.
// All clips are downloaded to FOOTAGE_DIR and served via /api/footage-file/:name.

// Node 16 compatibility
if (typeof fetch === 'undefined') { require('./script-generator'); }

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const FOOTAGE_DIR = path.join(os.tmpdir(), 'vcombine_footage');

function ensureDir() {
  if (!fs.existsSync(FOOTAGE_DIR)) fs.mkdirSync(FOOTAGE_DIR, { recursive: true });
}

// ── Pexels ────────────────────────────────────────────────────────────────────
async function searchPexels(query, apiKey, perPage = 4, orientation = 'landscape') {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}&size=medium`;
  const r = await fetch(url, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Pexels ${r.status}: ${txt.slice(0, 120)}`);
  }
  const data = await r.json();
  return (data.videos || []).flatMap(v => {
    const files = (v.video_files || []).filter(f => f.link && f.file_type === 'video/mp4');
    files.sort((a, b) => Math.abs(a.height - 720) - Math.abs(b.height - 720));
    const best = files[0];
    if (!best?.link) return [];
    return [{
      id:        `pexels_${v.id}`,
      url:       best.link,
      thumbnail: v.image,
      duration:  v.duration,
      width:     best.width,
      height:    best.height,
      source:    'pexels',
      query,
    }];
  });
}

// ── Pixabay ───────────────────────────────────────────────────────────────────
async function searchPixabay(query, apiKey, perPage = 4, orientation = 'landscape') {
  const url = `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&video_type=film&per_page=${perPage}&safesearch=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Pixabay ${r.status}`);
  const data = await r.json();
  return (data.hits || []).flatMap(v => {
    const vid = v.videos?.medium || v.videos?.large || v.videos?.small;
    if (!vid?.url) return [];
    const ratio = vid.width / (vid.height || 1);
    const isPortrait  = ratio < 0.8;
    const isLandscape = ratio > 1.2;
    if (orientation === 'portrait'  && !isPortrait)  return [];
    if (orientation === 'landscape' && !isLandscape) return [];
    return [{
      id:        `pixabay_${v.id}`,
      url:       vid.url,
      thumbnail: v.userImageURL || '',
      duration:  null,
      width:     vid.width,
      height:    vid.height,
      source:    'pixabay',
      query,
    }];
  });
}

// ── YouTube ───────────────────────────────────────────────────────────────────
// Returns search results (no download yet) shaped like Pexels/Pixabay results.
async function searchYouTubeFootage(query, perPage = 2, logger) {
  try {
    const { searchYouTube } = require('./youtube-search');
    const results = await searchYouTube(query, {
      limit:  perPage + 2,   // extra headroom — long videos filtered below
      filter: 'any',
      logger,
    });
    // Prefer shorter videos (under 10 min) for B-roll; skip very long ones
    const filtered = results.filter(v => !v.duration || v.duration < 600);
    return filtered.slice(0, perPage).map(v => ({
      id:        `youtube_${v.id}`,
      ytId:      v.id,
      ytUrl:     v.url,
      url:       v.url,          // used as display URL; actual download via yt-dlp
      thumbnail: v.thumbnail,
      duration:  v.duration,
      title:     v.title,
      source:    'youtube',
      query,
    }));
  } catch (e) {
    logger?.log?.(`   ⚠️  YouTube search: ${e.message}`);
    return [];
  }
}

// ── Download helpers ──────────────────────────────────────────────────────────

// Direct HTTP download (Pexels / Pixabay CDN URLs)
async function downloadClipHTTP(url, filename, logger) {
  ensureDir();
  const dest = path.join(FOOTAGE_DIR, filename);
  if (fs.existsSync(dest)) return dest;

  logger.log(`   ⬇️  ${filename} ← ${url.replace(/\?.*/, '').slice(0, 70)}…`);
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`Download ${r.status}: ${url.slice(0, 60)}`);
  const buf = await r.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
  logger.log(`   ✅ ${filename} — ${(buf.byteLength / 1048576).toFixed(1)} MB`);
  return dest;
}

// yt-dlp download (YouTube clips)
async function downloadClipYT(ytUrl, filename, quality = '720', logger) {
  ensureDir();
  const dest = path.join(FOOTAGE_DIR, filename);
  if (fs.existsSync(dest)) return dest;

  const { downloadYouTube, YT_DIR } = require('./youtube-downloader');
  logger.log(`   🎬 ${filename} ← YouTube yt-dlp…`);
  const { filename: dlFilename } = await downloadYouTube(ytUrl, { quality, logger });

  // Move from YT_DIR to FOOTAGE_DIR so it's served via /api/footage-file
  const src = path.join(YT_DIR, dlFilename);
  fs.renameSync(src, dest);
  logger.log(`   ✅ ${filename} — ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`);
  return dest;
}

// ── Combined search — Pexels + Pixabay + YouTube in parallel ─────────────────
async function searchAll(query, env, perPage, logger, orientation = 'landscape', useYoutube = false, usePexels = true, usePixabay = true) {
  const pexelsKey  = env.PEXELS_API_KEY;
  const pixabayKey = env.PIXABAY_API_KEY;

  if (!useYoutube && !usePexels && !usePixabay) {
    throw new Error('No footage sources enabled');
  }

  const tasks = [
    (usePexels  && pexelsKey)  ? searchPexels(query,  pexelsKey,  perPage, orientation) : Promise.resolve([]),
    (usePixabay && pixabayKey) ? searchPixabay(query, pixabayKey, perPage, orientation) : Promise.resolve([]),
    useYoutube ? searchYouTubeFootage(query, perPage, logger)                           : Promise.resolve([]),
  ];

  const [pexelsRes, pixabayRes, youtubeRes] = await Promise.allSettled(tasks);

  const pexels  = pexelsRes.status  === 'fulfilled' ? pexelsRes.value  : [];
  const pixabay = pixabayRes.status === 'fulfilled' ? pixabayRes.value : [];
  const youtube = youtubeRes.status === 'fulfilled' ? youtubeRes.value : [];

  if (pexelsRes.status  === 'rejected') logger?.log?.(`   ⚠️  Pexels: ${pexelsRes.reason?.message}`);
  if (pixabayRes.status === 'rejected') logger?.log?.(`   ⚠️  Pixabay: ${pixabayRes.reason?.message}`);
  if (youtubeRes.status === 'rejected') logger?.log?.(`   ⚠️  YouTube: ${youtubeRes.reason?.message}`);

  // Interleave: pexels, pixabay, youtube, pexels, pixabay, youtube …
  const merged = [];
  const len = Math.max(pexels.length, pixabay.length, youtube.length);
  for (let i = 0; i < len; i++) {
    if (i < pexels.length)  merged.push(pexels[i]);
    if (i < pixabay.length) merged.push(pixabay[i]);
    if (i < youtube.length) merged.push(youtube[i]);
  }
  return merged;
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Search Pexels, Pixabay, and optionally YouTube for each scene's keywords,
 * download the clips, and return clip objects ready for the pipeline.
 *
 * @param {Array<{id, visual_keywords, description}>} scenes
 * @param {object} env
 * @param {object} logger
 * @param {number} [clipsPerScene=2]
 * @param {string} [orientation='landscape']
 * @param {boolean} [useYoutube=false]
 * @param {string}  [ytQuality='720']
 */
async function findFootageForScenes(
  scenes, env, logger,
  clipsPerScene = 2,
  orientation   = 'landscape',
  useYoutube    = false,
  usePexels     = true,
  usePixabay    = true,
  ytQuality     = '720',
) {
  const pexelsKey  = env.PEXELS_API_KEY;
  const pixabayKey = env.PIXABAY_API_KEY;

  if (!useYoutube && !usePexels && !usePixabay) {
    throw new Error('No footage sources enabled');
  }
  if (!pexelsKey && !pixabayKey && !useYoutube) {
    throw new Error('No footage source configured. Add PEXELS_API_KEY / PIXABAY_API_KEY to .env, or enable YouTube.');
  }

  ensureDir();

  // Evict footage older than 2 hours
  try {
    const cutoff = Date.now() - 2 * 3600_000;
    for (const f of fs.readdirSync(FOOTAGE_DIR)) {
      const fp = path.join(FOOTAGE_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch (_) {}

  const results = [];

  for (const scene of scenes) {
    const keywords = (scene.visual_keywords || []).slice(0, 3);
    const query    = keywords.join(' ') ||
                     (scene.description || '').split(' ').slice(0, 4).join(' ') ||
                     'cinematic nature';

    const sources = [usePexels && 'Pexels', usePixabay && 'Pixabay', useYoutube && 'YouTube'].filter(Boolean).join(' + ');
    logger.log(`🔍 Scene ${scene.id}: "${query}" [${orientation}] (${sources})…`);

    const candidates = await searchAll(query, env, clipsPerScene + 2, logger, orientation, useYoutube, usePexels, usePixabay);

    if (!candidates.length) {
      logger.log(`   ⚠️  No results for scene ${scene.id} — skipping`);
      continue;
    }

    let downloaded = 0;
    for (const clip of candidates) {
      if (downloaded >= clipsPerScene) break;
      try {
        const filename = `footage_s${scene.id}_${clip.source}_${crypto.randomBytes(4).toString('hex')}.mp4`;

        let localPath;
        if (clip.source === 'youtube') {
          localPath = await downloadClipYT(clip.ytUrl, filename, ytQuality, logger);
        } else {
          localPath = await downloadClipHTTP(clip.url, filename, logger);
        }

        results.push({
          ...clip,
          filename,
          localPath,
          scene_id: scene.id,
          serveUrl: `/api/footage-file/${filename}`,
        });
        downloaded++;
      } catch (err) {
        logger.log(`   ⚠️  Download failed (${clip.source}): ${err.message}`);
      }
    }
  }

  logger.log(`✅ Footage finder done — ${results.length} clip(s) ready`);
  return results;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function clearAllFootage(logger) {
  ensureDir();
  let count = 0, bytes = 0;
  for (const f of fs.readdirSync(FOOTAGE_DIR)) {
    try {
      const fp = path.join(FOOTAGE_DIR, f);
      bytes += fs.statSync(fp).size;
      fs.unlinkSync(fp);
      count++;
    } catch (_) {}
  }
  if (logger) logger.log(`🗑️  Cleared ${count} footage file(s) (${(bytes / 1048576).toFixed(1)} MB)`);
  return { count, bytes };
}

function removeClip(filename) {
  try { fs.unlinkSync(path.join(FOOTAGE_DIR, filename)); } catch (_) {}
}

module.exports = { findFootageForScenes, removeClip, clearAllFootage, FOOTAGE_DIR };
