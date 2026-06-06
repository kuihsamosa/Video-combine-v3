// Footage Finder — searches Pexels (primary) and Pixabay (fallback) for stock video clips,
// then downloads them to a local temp directory so the pipeline can use them.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const FOOTAGE_DIR = path.join(os.tmpdir(), 'vcombine_footage');

function ensureDir() {
  if (!fs.existsSync(FOOTAGE_DIR)) fs.mkdirSync(FOOTAGE_DIR, { recursive: true });
}

// ── Pexels ────────────────────────────────────────────────────────────────────
// Free tier: 200 req/hour. Docs: https://www.pexels.com/api/documentation/
async function searchPexels(query, apiKey, perPage = 3) {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape&size=medium`;
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
    // Prefer 720 p (balance quality vs download size)
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
// Free tier: 100 req/min. Docs: https://pixabay.com/api/docs/
async function searchPixabay(query, apiKey, perPage = 3) {
  const url = `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&video_type=film&per_page=${perPage}&safesearch=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Pixabay ${r.status}`);
  const data = await r.json();
  return (data.hits || []).flatMap(v => {
    const vid = v.videos?.medium || v.videos?.large || v.videos?.small;
    if (!vid?.url) return [];
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

// ── Downloader ────────────────────────────────────────────────────────────────
async function downloadClip(url, filename, logger) {
  ensureDir();
  const dest = path.join(FOOTAGE_DIR, filename);
  if (fs.existsSync(dest)) return dest;   // already cached

  logger.log(`   ⬇️  ${filename} ← ${url.replace(/\?.*/, '').slice(0, 70)}…`);
  const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`Download ${r.status}: ${url.slice(0, 60)}`);

  const buf = await r.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
  logger.log(`   ✅ ${filename} (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
  return dest;
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Search and download stock footage for each scene.
 *
 * @param {Array<{id, visual_keywords, description}>} scenes
 * @param {object} env               — process.env
 * @param {object} logger            — { log, error }
 * @param {number} [clipsPerScene=2] — how many clips to download per scene
 * @returns {Promise<Array>} Array of clip objects with localPath + serveUrl
 */
async function findFootageForScenes(scenes, env, logger, clipsPerScene = 2) {
  const pexelsKey  = env.PEXELS_API_KEY;
  const pixabayKey = env.PIXABAY_API_KEY;

  if (!pexelsKey && !pixabayKey) {
    throw new Error('No footage API key configured. Add PEXELS_API_KEY or PIXABAY_API_KEY to .env');
  }

  ensureDir();

  // Clean up old footage (older than 2 hours) to avoid filling /tmp
  try {
    const cutoff = Date.now() - 2 * 3600 * 1000;
    for (const f of fs.readdirSync(FOOTAGE_DIR)) {
      const fp = path.join(FOOTAGE_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch (_) {}

  const results = [];

  for (const scene of scenes) {
    const keywords = (scene.visual_keywords || []).slice(0, 3);
    const query = keywords.join(' ') || (scene.description || '').split(' ').slice(0, 4).join(' ') || 'cinematic nature';

    logger.log(`🔍 Scene ${scene.id}: searching "${query}"…`);

    let candidates = [];

    // Primary: Pexels
    if (pexelsKey) {
      try {
        candidates = await searchPexels(query, pexelsKey, clipsPerScene + 1);
      } catch (err) {
        logger.log(`   ⚠️  Pexels: ${err.message}`);
      }
    }

    // Fallback: Pixabay
    if (!candidates.length && pixabayKey) {
      try {
        candidates = await searchPixabay(query, pixabayKey, clipsPerScene + 1);
      } catch (err) {
        logger.log(`   ⚠️  Pixabay: ${err.message}`);
      }
    }

    if (!candidates.length) {
      logger.log(`   ⚠️  No results for scene ${scene.id} — skipping`);
      continue;
    }

    // Download up to clipsPerScene clips
    for (const clip of candidates.slice(0, clipsPerScene)) {
      try {
        const ext      = 'mp4';
        const filename = `footage_s${scene.id}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const localPath = await downloadClip(clip.url, filename, logger);
        results.push({
          ...clip,
          filename,
          localPath,
          scene_id:  scene.id,
          serveUrl:  `/api/footage-file/${filename}`,
        });
      } catch (err) {
        logger.log(`   ⚠️  Download failed: ${err.message}`);
      }
    }
  }

  logger.log(`✅ Footage finder done — ${results.length} clip(s) ready`);
  return results;
}

// Clean up a specific clip after it has been used
function removeClip(filename) {
  try { fs.unlinkSync(path.join(FOOTAGE_DIR, filename)); } catch (_) {}
}

module.exports = { findFootageForScenes, removeClip, FOOTAGE_DIR };
