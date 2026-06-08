// Image Finder — downloads still images and converts them to video clips with Ken Burns effect.
// Sources (in priority order):
//   1. Google Custom Search  (GOOGLE_API_KEY + GOOGLE_CSE_ID) — actual Google Images, 100 req/day free
//   2. Unsplash              (UNSPLASH_ACCESS_KEY)             — 50 req/hour free, top quality
//   3. Pexels Photos         (PEXELS_API_KEY)                  — reuses existing key
//   4. Pixabay Images        (PIXABAY_API_KEY)                 — reuses existing key
// Used as a fallback when Pexels/Pixabay video returns 0 results for a scene.

// Node 16 compatibility
if (typeof fetch === 'undefined') { require('./script-generator'); }

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util   = require('util');
const execFileAsync = util.promisify(execFile);

const IMAGE_DIR = path.join(os.tmpdir(), 'vcombine_images');

function ensureDir() {
  if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

// ── Google Custom Search Images ───────────────────────────────────────────────
// Free: 100 queries/day. Setup:
//   1. https://console.cloud.google.com → enable "Custom Search JSON API" → create API key → GOOGLE_API_KEY
//   2. https://cse.google.com → New search engine → "Search the entire web" ON → Image search ON → copy ID → GOOGLE_CSE_ID
async function searchGoogleImages(query, apiKey, cseId, perPage = 5, orientation = 'landscape') {
  const params = new URLSearchParams({
    key:        apiKey,
    cx:         cseId,
    q:          query,
    searchType: 'image',
    num:        Math.min(perPage, 10), // Google max is 10
    imgSize:    orientation === 'portrait' ? 'large' : 'xlarge',
    safe:       'active',
  });
  const url = `https://www.googleapis.com/customsearch/v1?${params}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: { message: r.statusText } }));
    throw new Error(`Google CSE ${r.status}: ${err?.error?.message || r.statusText}`);
  }
  const data = await r.json();
  return (data.items || []).map(item => ({
    id:     `google_${encodeURIComponent(item.link).slice(0, 40)}`,
    url:    item.link,
    width:  parseInt(item.image?.width)  || 1280,
    height: parseInt(item.image?.height) || 720,
    source: 'google_cse',
    query,
  })).filter(p => p.url && /\.(jpe?g|png|webp)(\?.*)?$/i.test(p.url));
}

// ── Unsplash Photos ───────────────────────────────────────────────────────────
// Free: 50 requests/hour. Setup:
//   https://unsplash.com/developers → New Application → copy "Access Key" → UNSPLASH_ACCESS_KEY
async function searchUnsplashPhotos(query, accessKey, perPage = 5, orientation = 'landscape') {
  const params = new URLSearchParams({
    query,
    per_page:    perPage,
    orientation: orientation === 'portrait' ? 'portrait' : 'landscape',
  });
  const url = `https://api.unsplash.com/search/photos?${params}`;
  const r = await fetch(url, {
    headers: { Authorization: `Client-ID ${accessKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Unsplash ${r.status}`);
  const data = await r.json();
  return (data.results || []).map(p => ({
    id:     `unsplash_${p.id}`,
    url:    p.urls?.full || p.urls?.regular,
    width:  p.width,
    height: p.height,
    source: 'unsplash',
    query,
    credit: `Photo by ${p.user?.name} on Unsplash`,
  })).filter(p => p.url);
}

// ── Pexels Photos (still images, not video) ───────────────────────────────────
async function searchPexelsPhotos(query, apiKey, perPage = 4, orientation = 'landscape') {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}`;
  const r = await fetch(url, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Pexels Photos ${r.status}`);
  const data = await r.json();
  return (data.photos || []).map(p => ({
    id:     `pexels_photo_${p.id}`,
    url:    p.src?.large2x || p.src?.large || p.src?.original,
    width:  p.width,
    height: p.height,
    source: 'pexels_photo',
    query,
  })).filter(p => p.url);
}

// ── Pixabay Images (still images) ─────────────────────────────────────────────
async function searchPixabayPhotos(query, apiKey, perPage = 4, orientation = 'horizontal') {
  const url = `https://pixabay.com/api/?key=${apiKey}&q=${encodeURIComponent(query)}&image_type=photo&per_page=${perPage}&orientation=${orientation}&safesearch=true&min_width=1280`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Pixabay Photos ${r.status}`);
  const data = await r.json();
  return (data.hits || []).map(h => ({
    id:     `pixabay_photo_${h.id}`,
    url:    h.largeImageURL || h.webformatURL,
    width:  h.imageWidth,
    height: h.imageHeight,
    source: 'pixabay_photo',
    query,
  })).filter(p => p.url);
}

// ── Download image ────────────────────────────────────────────────────────────
async function downloadImage(url, filename, logger) {
  ensureDir();
  const dest = path.join(IMAGE_DIR, filename);
  if (fs.existsSync(dest)) return dest;

  logger?.log?.(`   🖼️  ${filename} ← ${url.slice(0, 70)}…`);
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Image download ${r.status}`);
  const buf = await r.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
  return dest;
}

// ── Ken Burns — image → video clip ───────────────────────────────────────────
// Generates a slow zoom-in (or zoom-out alternating) with smooth pan.
// Output: landscape 1280×720 MP4, durationSecs long.
async function imageToVideoClip(imagePath, outputPath, durationSecs = 5, direction = 'in', logger) {
  const fps      = 25;
  const frames   = durationSecs * fps;
  const w        = 1280;
  const h        = 720;

  // Ken Burns: zoom from 1.0→1.08 (in) or 1.08→1.0 (out), centred pan
  const zoomExpr = direction === 'out'
    ? `zoom='if(eq(on,1),1.08,max(1.0,zoom-0.0016))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
    : `zoom='if(eq(on,1),1.0,min(1.08,zoom+0.0016))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;

  const filterChain = [
    `scale=${w * 2}:${h * 2}`,            // oversample so zoom doesn't show edges
    `zoompan=${zoomExpr}:d=${frames}:fps=${fps}:s=${w}x${h}`,
    `setsar=1`,
  ].join(',');

  const args = [
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-vf', filterChain,
    '-t', String(durationSecs),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-an',
    outputPath,
  ];

  logger?.log?.(`   🎞️  Ken Burns (${direction}) → ${path.basename(outputPath)}`);
  try {
    await execFileAsync('ffmpeg', args, { timeout: 60_000 });
  } catch (e) {
    throw new Error(`Ken Burns render failed: ${e.message?.slice(0, 120)}`);
  }
  return outputPath;
}

// ── Main: find images for a scene, convert to video clips ────────────────────
/**
 * Downloads still images for a scene and converts each to a video clip.
 * Used as a fallback when video sources return nothing for a scene.
 *
 * @param {object} scene  — scene object with visual_keywords, search_queries, id
 * @param {object} env    — process.env
 * @param {object} logger
 * @param {number} want   — number of clips to produce
 * @param {string} orientation — 'landscape' | 'portrait'
 * @param {number} clipDuration — seconds per image clip (default 5)
 * @returns {Array} clip objects shaped like footage-finder clips
 */
async function findImagesForScene(scene, env, logger, want = 2, orientation = 'landscape', clipDuration = 5) {
  const pexelsKey   = env.PEXELS_API_KEY;
  const pixabayKey  = env.PIXABAY_API_KEY;
  const unsplashKey = env.UNSPLASH_ACCESS_KEY;
  const googleKey   = env.GOOGLE_API_KEY;
  const googleCseId = env.GOOGLE_CSE_ID;

  const hasGoogle   = !!(googleKey && googleCseId);
  const hasUnsplash = !!unsplashKey;

  ensureDir();

  const pexelsOrientation  = orientation === 'portrait' ? 'portrait'  : 'landscape';
  const pixabayOrientation = orientation === 'portrait' ? 'vertical'  : 'horizontal';

  // Build query list — from most specific to broadest
  const kw  = (scene.visual_keywords || []).filter(Boolean);
  const sq  = (scene.search_queries  || []).filter(Boolean);
  const queries = [...new Set([...sq, kw.slice(0, 3).join(' '), kw[0], kw[1], 'nature landscape'].filter(Boolean))];

  // Log which sources are active
  const activeSources = [
    hasGoogle   && 'Google Images',
    hasUnsplash && 'Unsplash',
    pexelsKey   && 'Pexels Photos',
    pixabayKey  && 'Pixabay Photos',
  ].filter(Boolean);
  logger?.log?.(`   🖼️  Image sources: ${activeSources.join(', ') || 'none configured'}`);

  const seenUrls = new Set();
  const clips    = [];
  let   directionToggle = 0; // alternate Ken Burns direction per clip

  for (const query of queries) {
    if (clips.length >= want) break;

    let candidates = [];
    try {
      // Fire all available sources in parallel — priority order doesn't matter here
      // since we deduplicate by URL and process in insertion order (Google first)
      const searches = await Promise.allSettled([
        hasGoogle   ? searchGoogleImages(query, googleKey, googleCseId, want + 3, orientation)       : Promise.resolve([]),
        hasUnsplash ? searchUnsplashPhotos(query, unsplashKey, want + 3, orientation)                : Promise.resolve([]),
        pexelsKey   ? searchPexelsPhotos(query, pexelsKey, want + 2, pexelsOrientation)              : Promise.resolve([]),
        pixabayKey  ? searchPixabayPhotos(query, pixabayKey, want + 2, pixabayOrientation)           : Promise.resolve([]),
      ]);
      // Google first, then Unsplash, then Pexels, then Pixabay
      for (const r of searches) {
        if (r.status === 'fulfilled') candidates.push(...r.value);
        else logger?.log?.(`   ⚠️  Image source error: ${r.reason?.message?.slice(0, 80)}`);
      }
    } catch (_) {}

    const fresh = candidates.filter(c => !seenUrls.has(c.url));
    fresh.forEach(c => seenUrls.add(c.url));

    for (const img of fresh) {
      if (clips.length >= want) break;
      try {
        const ext      = img.url.includes('.jpg') ? 'jpg' : 'jpg';
        const imgFile  = `img_s${scene.id}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const vidFile  = `img_clip_s${scene.id}_${crypto.randomBytes(4).toString('hex')}.mp4`;
        const imgPath  = await downloadImage(img.url, imgFile, logger);
        const vidPath  = path.join(IMAGE_DIR, vidFile);
        const dir      = directionToggle % 2 === 0 ? 'in' : 'out';
        await imageToVideoClip(imgPath, vidPath, clipDuration, dir, logger);
        directionToggle++;

        clips.push({
          id:        img.id,
          url:       img.url,
          localPath: vidPath,
          filename:  vidFile,
          duration:  clipDuration,
          source:    img.source,
          scene_id:  scene.id,
          isImage:   true,
          serveUrl:  `/api/footage-file/${vidFile}`,
        });
        logger?.log?.(`   ✅ Image clip ready: ${vidFile}`);
      } catch (err) {
        logger?.log?.(`   ⚠️  Image clip failed: ${err.message}`);
      }
    }
  }

  return clips;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function clearAllImages(logger) {
  ensureDir();
  let count = 0, bytes = 0;
  for (const f of fs.readdirSync(IMAGE_DIR)) {
    try {
      const fp = path.join(IMAGE_DIR, f);
      bytes += fs.statSync(fp).size;
      fs.unlinkSync(fp);
      count++;
    } catch (_) {}
  }
  if (logger) logger.log(`🗑️  Cleared ${count} image file(s) (${(bytes / 1048576).toFixed(1)} MB)`);
  return { count, bytes };
}

module.exports = { findImagesForScene, imageToVideoClip, clearAllImages, IMAGE_DIR };
