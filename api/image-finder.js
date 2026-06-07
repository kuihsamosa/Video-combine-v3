// Image Finder — downloads still images and converts them to video clips with Ken Burns effect.
// Sources: Pexels Photos (reuses existing key) + Unsplash (free, no auth for basic search via Unsplash Source).
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
  const pexelsKey  = env.PEXELS_API_KEY;
  const pixabayKey = env.PIXABAY_API_KEY;

  ensureDir();

  const pexelsOrientation  = orientation === 'portrait' ? 'portrait' : 'landscape';
  const pixabayOrientation = orientation === 'portrait' ? 'vertical'  : 'horizontal';

  // Build query list (same tiered approach as footage-finder)
  const kw  = (scene.visual_keywords || []).filter(Boolean);
  const sq  = (scene.search_queries  || []).filter(Boolean);
  const queries = [...new Set([...sq, kw.slice(0, 3).join(' '), kw[0], kw[1], 'nature landscape'].filter(Boolean))];

  const seenUrls = new Set();
  const clips    = [];
  let   directionToggle = 0; // alternate Ken Burns direction per clip

  for (const query of queries) {
    if (clips.length >= want) break;

    let candidates = [];
    try {
      const [pRes, pxRes] = await Promise.allSettled([
        pexelsKey  ? searchPexelsPhotos(query, pexelsKey, want + 2, pexelsOrientation)   : Promise.resolve([]),
        pixabayKey ? searchPixabayPhotos(query, pixabayKey, want + 2, pixabayOrientation) : Promise.resolve([]),
      ]);
      if (pRes.status  === 'fulfilled') candidates.push(...pRes.value);
      if (pxRes.status === 'fulfilled') candidates.push(...pxRes.value);
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
