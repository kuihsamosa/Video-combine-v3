// Title Card Generator
// Creates short MP4 clips with bold chapter title text over a dark-blue geometric
// background — matches the "High-Retention Educational Explainer" production preset.
// Used by the scheduler to inject chapter transitions between scene segments.

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const CARD_DIR = path.join(os.tmpdir(), 'vcombine_titlecards');

function ensureDir() {
  if (!fs.existsSync(CARD_DIR)) fs.mkdirSync(CARD_DIR, { recursive: true });
}

// ── Escape text for FFmpeg drawtext ──────────────────────────────────────────
function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  "\\'")
    .replace(/:/g,  '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/%/g,  '\\%');
}

/**
 * Generates a title card MP4 clip.
 *
 * @param {object} opts
 * @param {string}  opts.title        — Chapter title text (will be uppercased)
 * @param {string}  opts.subtitle     — Optional subtitle / episode label (smaller text)
 * @param {number}  opts.durationSecs — Clip length in seconds (default 2.0)
 * @param {string}  opts.outputPath   — Full path for the output .mp4
 * @param {string}  opts.orientation  — 'landscape' (1280×720) | 'portrait' (720×1280)
 * @param {object}  opts.logger
 * @returns {Promise<string>} outputPath
 */
async function generateTitleCard({
  title,
  subtitle     = '',
  durationSecs = 2.0,
  outputPath,
  orientation  = 'landscape',
  logger       = { log: () => {} },
} = {}) {
  ensureDir();

  const isPortrait = orientation === 'portrait';
  const W = isPortrait ? 720  : 1280;
  const H = isPortrait ? 1280 : 720;

  const titleText    = (title || 'Chapter').toUpperCase();
  const subtitleText = (subtitle || '').toUpperCase();

  // ── Design constants ───────────────────────────────────────────────────────
  // Primary dark-blue background  #0d1b2e
  // Accent teal highlight strip   #00b4d8
  // White title text
  // Subtle geometric diagonal lines drawn via overlapping box primitives

  const bgColor      = '0x0d1b2e';   // dark navy
  const accentColor  = '0x00b4d8';   // teal
  const titleColor   = 'white';
  const subtitleClr  = '0xaaccdd';   // muted teal-white

  const titleFontSize    = isPortrait ? 72  : 64;
  const subtitleFontSize = isPortrait ? 38  : 32;

  // Accent strip: a thin teal horizontal bar above the title
  // We use drawbox for the strip and drawtext for the words.
  const stripH    = isPortrait ? 8  : 6;
  const stripY    = Math.round(H * 0.42);   // just above centre
  const titleY    = stripY + stripH + 24;
  const subtitleY = titleY + titleFontSize + 18;

  // Diagonal geometric accent lines (top-right corner)
  // Implemented as rotated, semi-transparent boxes via overlay lavfi.
  // Simpler: just two off-centre drawbox strips for a subtle geometric feel.

  const fps    = 25;
  const frames = Math.ceil(durationSecs * fps);

  // Build a lavfi filter chain:
  //   1. color source (background)
  //   2. drawbox — geometric accent strips (top-right triangular feel)
  //   3. drawbox — teal accent strip above title
  //   4. drawtext — chapter title (bold, centered, ALL CAPS)
  //   5. drawtext — subtitle (if any)
  //   6. fade in/out (20 frames each)

  const geomStrip1 = `drawbox=x=${W - 260}:y=0:w=260:h=4:color=0x1a3050@0.6:t=fill`;
  const geomStrip2 = `drawbox=x=${W - 190}:y=10:w=190:h=4:color=0x00b4d8@0.3:t=fill`;
  const geomStrip3 = `drawbox=x=0:y=${H - 5}:w=${Math.round(W * 0.15)}:h=5:color=0x00b4d8@0.4:t=fill`;

  const accentBar  = `drawbox=x=${Math.round(W * 0.25)}:y=${stripY}:w=${Math.round(W * 0.5)}:h=${stripH}:color=${accentColor}@0.9:t=fill`;

  const titleEsc = escapeDrawtext(titleText);
  const drawTitle = [
    `drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial\\ Black.ttf`,
    `fontsize=${titleFontSize}`,
    `fontcolor=${titleColor}`,
    `x=(w-text_w)/2`,
    `y=${titleY}`,
    `text='${titleEsc}'`,
    `shadowcolor=black@0.8`,
    `shadowx=2`,
    `shadowy=3`,
  ].join(':');

  let filterParts = [
    `color=c=${bgColor}:s=${W}x${H}:r=${fps}`,
    geomStrip1,
    geomStrip2,
    geomStrip3,
    accentBar,
    drawTitle,
  ];

  if (subtitleText) {
    const subEsc = escapeDrawtext(subtitleText);
    const drawSub = [
      `drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf`,
      `fontsize=${subtitleFontSize}`,
      `fontcolor=${subtitleClr}`,
      `x=(w-text_w)/2`,
      `y=${subtitleY}`,
      `text='${subEsc}'`,
    ].join(':');
    filterParts.push(drawSub);
  }

  // Fade in (20f) + fade out (20f)
  const fadeIn  = `fade=t=in:st=0:d=${(20/fps).toFixed(3)}`;
  const fadeOut = `fade=t=out:st=${(durationSecs - 20/fps).toFixed(3)}:d=${(20/fps).toFixed(3)}`;
  filterParts.push(fadeIn, fadeOut);

  // Chain everything with comma (all video filters on the lavfi source)
  const vf = filterParts.join(',');

  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${bgColor}:s=${W}x${H}:r=${fps}`,
    '-vf', vf.replace(`color=c=${bgColor}:s=${W}x${H}:r=${fps},`, ''), // remove duplicate color src
    '-t', String(durationSecs),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-an',
    outputPath,
  ];

  logger.log(`🎬 Title card: "${titleText}" (${durationSecs}s)`);
  try {
    await execFileAsync('ffmpeg', args, { timeout: 30_000 });
  } catch (e) {
    // Try fallback with system font path (Linux / other macOS locations)
    const fallbackArgs = args.map(a =>
      a.replace('/System/Library/Fonts/Supplemental/Arial\\ Black.ttf', '')
       .replace('/System/Library/Fonts/Supplemental/Arial.ttf', '')
    );
    // Rebuild vf without fontfile specification
    const vfSimple = vf
      .replace(/fontfile=[^:]+:/g, '')
      .replace(`color=c=${bgColor}:s=${W}x${H}:r=${fps},`, '');

    const simpleArgs = [
      '-y', '-f', 'lavfi',
      '-i', `color=c=${bgColor}:s=${W}x${H}:r=${fps}`,
      '-vf', vfSimple,
      '-t', String(durationSecs),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-an',
      outputPath,
    ];
    try {
      await execFileAsync('ffmpeg', simpleArgs, { timeout: 30_000 });
    } catch (e2) {
      logger.log(`   ⚠️  Title card render failed: ${e2.message?.slice(0, 120)}`);
      throw new Error(`Title card failed: ${e2.message?.slice(0, 200)}`);
    }
  }

  logger.log(`   ✅ Title card saved: ${path.basename(outputPath)}`);
  return outputPath;
}

/**
 * Extract chapter markers from a script's scenes array.
 * The script generator emits scenes with `chapter_title` when a new chapter starts.
 * Returns a Map<sceneId, chapterTitle>.
 *
 * @param {Array} scenes
 * @returns {Map<number, string>}
 */
function extractChapterMarkers(scenes) {
  const map = new Map();
  for (const scene of scenes) {
    if (scene.chapter_title) {
      map.set(scene.id, scene.chapter_title);
    }
  }
  return map;
}

function clearAllCards(logger) {
  ensureDir();
  let count = 0;
  for (const f of fs.readdirSync(CARD_DIR)) {
    try { fs.unlinkSync(path.join(CARD_DIR, f)); count++; } catch (_) {}
  }
  if (logger) logger.log(`🗑️  Cleared ${count} title card(s)`);
  return count;
}

module.exports = { generateTitleCard, extractChapterMarkers, clearAllCards, CARD_DIR };
