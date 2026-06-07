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

  // ── Build tiered query list for a scene ────────────────────────────────────
  function buildQueryTiers(scene) {
    const kw   = (scene.visual_keywords  || []).filter(Boolean);
    const sq   = (scene.search_queries   || []).filter(Boolean);
    const desc = (scene.description      || '').split(/\s+/).slice(0, 4).join(' ');
    const tiers = [];

    // Tier 0: pre-built search_queries from the LLM (most reliable)
    sq.forEach(q => tiers.push(q.trim()));

    // Tier 1: all keywords joined (specific combo)
    if (kw.length >= 2) tiers.push(kw.slice(0, 3).join(' '));

    // Tier 2: first keyword alone (still specific, fewer words)
    if (kw.length >= 1) tiers.push(kw[0]);

    // Tier 3: second keyword (medium specificity)
    if (kw.length >= 2) tiers.push(kw[1]);

    // Tier 4: description snippet
    if (desc) tiers.push(desc);

    // Tier 5: third keyword (broad category)
    if (kw.length >= 3) tiers.push(kw[2]);

    // Tier 6: fourth keyword (broad fallback)
    if (kw.length >= 4) tiers.push(kw[3]);

    // Tier 7: fifth keyword (universal fallback)
    if (kw.length >= 5) tiers.push(kw[4]);

    // Ultimate fallback: something always returns results
    tiers.push('cinematic nature');

    // Deduplicate while preserving order
    return [...new Set(tiers.map(t => t.toLowerCase().trim()))].filter(Boolean);
  }

  // ── Try each query tier until we have enough clips for a scene ──────────────
  async function downloadForScene(scene, want) {
    const tiers    = buildQueryTiers(scene);
    const sources  = [usePexels && 'Pexels', usePixabay && 'Pixabay', useYoutube && 'YouTube'].filter(Boolean).join(' + ');
    const seenUrls = new Set();
    const clips    = [];

    for (const query of tiers) {
      if (clips.length >= want) break;
      const still = want - clips.length;
      logger.log(`🔍 Scene ${scene.id}: "${query}" [${orientation}] (${sources})…`);

      let candidates;
      try {
        candidates = await searchAll(query, env, still + 3, logger, orientation, useYoutube, usePexels, usePixabay);
      } catch (e) {
        logger.log(`   ⚠️  Search error (${query}): ${e.message}`);
        continue;
      }

      // Filter out already-seen URLs to avoid duplicate clips
      const fresh = candidates.filter(c => !seenUrls.has(c.url));
      fresh.forEach(c => seenUrls.add(c.url));

      if (!fresh.length) continue;

      for (const clip of fresh) {
        if (clips.length >= want) break;
        try {
          const filename  = `footage_s${scene.id}_${clip.source}_${crypto.randomBytes(4).toString('hex')}.mp4`;
          const localPath = clip.source === 'youtube'
            ? await downloadClipYT(clip.ytUrl, filename, ytQuality, logger)
            : await downloadClipHTTP(clip.url, filename, logger);
          clips.push({ ...clip, filename, localPath, scene_id: scene.id, serveUrl: `/api/footage-file/${filename}` });
        } catch (err) {
          logger.log(`   ⚠️  Download failed (${clip.source}): ${err.message}`);
        }
      }
    }
    return clips;
  }

  const results = [];

  // ── Pass 1: one scene at a time, tiered queries ─────────────────────────────
  for (const scene of scenes) {
    const clips = await downloadForScene(scene, clipsPerScene);
    if (!clips.length) {
      logger.log(`   ⚠️  No video clips for scene ${scene.id} — falling back to image search…`);
      // Image fallback: convert still photos to Ken Burns video clips
      try {
        const { findImagesForScene } = require('./image-finder');
        const imageClips = await findImagesForScene(scene, env, logger, clipsPerScene, orientation, 5);
        if (imageClips.length) {
          logger.log(`   🖼️  Image fallback: ${imageClips.length} still(s) → video clips for scene ${scene.id}`);
          results.push(...imageClips);
        } else {
          logger.log(`   ⚠️  Image fallback also empty for scene ${scene.id}`);
        }
      } catch (imgErr) {
        logger.log(`   ⚠️  Image fallback error scene ${scene.id}: ${imgErr.message}`);
      }
    } else {
      results.push(...clips);
    }
  }

  // ── Pass 2: coverage top-up ─────────────────────────────────────────────────
  // If a targetDurationSeconds was provided (set by scheduler from audio length),
  // keep pulling extra clips (with broader queries) until total clip seconds >= target.
  const targetSecs = clipsPerScene._targetDurationSeconds || 0; // smuggled in via property
  if (targetSecs > 0) {
    const totalClipSecs = results.reduce((s, c) => s + (c.duration || 8), 0);
    const deficit = targetSecs - totalClipSecs;
    if (deficit > 0) {
      const extraNeeded = Math.ceil(deficit / 8);
      logger.log(`📐 Coverage gap: ${deficit.toFixed(0)}s short — fetching ${extraNeeded} extra clip(s)…`);
      for (let i = 0; i < Math.min(extraNeeded, scenes.length * 2); i++) {
        const scene = scenes[i % scenes.length];
        const extra = await downloadForScene(scene, 1);
        if (extra.length) {
          results.push(...extra);
        } else {
          // Last resort: image for top-up too
          try {
            const { findImagesForScene } = require('./image-finder');
            const imgExtra = await findImagesForScene(scene, env, logger, 1, orientation, 5);
            results.push(...imgExtra);
          } catch (_) {}
        }
        const nowSecs = results.reduce((s, c) => s + (c.duration || 8), 0);
        if (nowSecs >= targetSecs) break;
      }
    }
  }

  const totalDur = results.reduce((s, c) => s + (c.duration || 8), 0);
  const videoCount = results.filter(c => !c.isImage).length;
  const imageCount = results.filter(c =>  c.isImage).length;
  logger.log(`✅ Footage finder done — ${videoCount} video clip(s) + ${imageCount} image clip(s), ~${totalDur.toFixed(0)}s raw footage`);
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
