// Video combiner API handler
// Combines N randomized segments per input video and returns a combined output.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { LIMITS, getVideoPreset } = require('./app-config');
const { runFfprobeDurationSeconds, runFfmpeg } = require('./ffmpeg');
const { getVideoContentTypeByExt, safeRm } = require('./http-utils');

// Get hardware-aware limits from resource manager
let videoSegmentConcurrency = 2;
try {
  const rm = require('./resource-manager');
  videoSegmentConcurrency = rm.getSettings().videoSegmentConcurrency;
  console.log(`[VideoCombiner] Using hardware-aware segment concurrency: ${videoSegmentConcurrency}`);
} catch (e) {
  console.log(`[VideoCombiner] Using default segment concurrency: ${videoSegmentConcurrency}`);
}

const CONFIG = {
  allowedFormats: ['mp4', 'avi', 'mov', 'mkv'],
  tempDir: path.join(__dirname, '../temp'),
  outputDir: path.join(__dirname, '../output')
};

function ensureDirectories() {
  [CONFIG.tempDir, CONFIG.outputDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function toFiniteNumber(val, fallback) {
  const n = typeof val === 'string' && val.trim() === '' ? NaN : Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function createSeededRandom(seed) {
  if (seed === null || seed === undefined) return Math.random;
  let s = Number(seed) || 0;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateRandomCuts(duration, minDuration, maxDuration, randomSeed, segmentsPerVideo, targetPerSegmentSeconds) {
  const random = createSeededRandom(randomSeed);

  if (!Number.isFinite(duration) || duration <= 0) {
    return [];
  }

  const segments = Math.max(1, Math.min(20, Math.floor(segmentsPerVideo || 1)));

  // If a target per-segment duration is provided, use it as a strong hint.
  let minD = toFiniteNumber(minDuration, 0.1);
  let maxD = toFiniteNumber(maxDuration, minD + 0.1);
  if (Number.isFinite(targetPerSegmentSeconds) && targetPerSegmentSeconds > 0) {
    minD = targetPerSegmentSeconds;
    maxD = targetPerSegmentSeconds;
  }

  // Sanitize min/max relative to duration
  const safeMin = Math.max(0.1, Math.min(minD, duration));
  const safeMax = Math.max(safeMin, Math.min(maxD, duration));

  const cuts = [];
  for (let i = 0; i < segments; i++) {
    const segmentDuration = Math.min(duration, safeMin + random() * (safeMax - safeMin));
    const maxStart = Math.max(0, duration - segmentDuration);
    const start = maxStart > 0 ? random() * maxStart : 0;
    const end = Math.min(duration, start + segmentDuration);
    cuts.push([start, end]);
  }
  return cuts;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const concurrency = Math.max(1, Math.min(limit || 1, items.length || 1));

  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) break;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

// Returns [W, H] for the requested orientation
function orientationDims(orientation) {
  return orientation === 'portrait' ? [1080, 1920] : [1920, 1080];
}

function buildScalePadFilter(orientation = 'landscape') {
  const [w, h] = orientationDims(orientation);
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
}

function hasAudioStream(inputPath) {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { timeout: 6000 }).toString().trim();
    return out.includes('audio');
  } catch (_) {
    return false; // assume no audio on probe failure
  }
}

async function extractSegment({ inputPath, startTime, durationSeconds, outputPath, preset, logger, orientation = 'landscape', extraVideoFilter = null, targetSampleRate = 48000 }) {
  const audioExists = hasAudioStream(inputPath);

  // Base args: seek + input
  const args = ['-y', '-ss', String(startTime), '-i', inputPath];

  // If no audio stream, inject a lavfi silent source so every segment has audio.
  // This is critical for xfade/acrossfade to work on mute stock footage.
  // Use target sample rate for consistency with voiceover
  if (!audioExists) {
    args.push('-f', 'lavfi', '-i', `anullsrc=r=${targetSampleRate}:cl=stereo`);
  }

  // Build video filter: scale/pad always applied; optional extra filter chained after
  const scaleFilter = buildScalePadFilter(orientation);
  const vf = extraVideoFilter ? `${scaleFilter},${extraVideoFilter}` : scaleFilter;

  args.push(
    '-t', String(durationSeconds),
    '-vf', vf,
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', preset.preset,
    '-crf', String(preset.crf),
    '-pix_fmt', 'yuv420p',
    '-map', '0:v:0',
    '-map', audioExists ? '0:a:0' : '1:a:0',
    '-c:a', 'aac',
    '-b:a', preset.audioBitrate,
    '-ar', String(targetSampleRate), // Ensure consistent sample rate
    '-avoid_negative_ts', '1',
    '-movflags', '+faststart',
    outputPath
  );

  await runFfmpeg(args, {
    logger,
    onLine: (line) => {
      if (line.includes('frame=') || line.includes('time=')) return;
      logger?.log?.(line);
    }
  });
}

// Valid xfade transition names supported by FFmpeg libavfilter
const XFADE_TRANSITIONS = new Set([
  'fade','fadeblack','fadewhite','fadegrays',
  'wipeleft','wiperight','wipeup','wipedown',
  'slideleft','slideright','slideup','slidedown',
  'smoothleft','smoothright','smoothup','smoothdown',
  'circlecrop','rectcrop','circleopen','circleclose',
  'vertopen','vertclose','horzopen','horzclose',
  'dissolve','pixelize','distance','zoomin',
  'diagtl','diagtr','diagbl','diagbr',
  'hlslice','hrslice','vuslice','vdslice',
  'coverleft','coverright','revealleft','revealright',
]);

// Get duration of a video file in seconds using ffprobe
async function getSegmentDuration(filePath) {
  try {
    const { stdout } = await require('child_process').execFileSync
      ? (() => { throw new Error('use execFile'); })()
      : { stdout: '' };
  } catch(_) {}
  // Use synchronous approach for simplicity inside combineVideos
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 8000 }).toString().trim();
    return parseFloat(out) || 0;
  } catch(_) { return 0; }
}

async function combineVideos({ segmentPaths, listPath, outputPath, preset, logger, outputFormat, transition = 'none', transitionDuration = 0.5 }) {
  const n = segmentPaths.length;
  logger?.log?.(`[FFMPEG] Combining ${n} segments → ${outputPath} [transition: ${transition}]`);

  // ── Simple concat (no transitions) ──────────────────────────────────────────
  if (transition === 'none' || !XFADE_TRANSITIONS.has(transition) || n < 2) {
    const fileListContent = segmentPaths
      .map(p => `file '${p.replace(/'/g, "'\"'\"'")}'`)
      .join('\n');
    fs.writeFileSync(listPath, fileListContent);

    const args = [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', listPath, '-fflags', '+genpts',
      '-c:v', 'libx264', '-preset', preset.preset, '-crf', String(preset.crf),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', preset.audioBitrate,
    ];
    if (outputFormat === 'mp4' || outputFormat === 'mov') args.push('-movflags', '+faststart');
    args.push(outputPath);

    await runFfmpeg(args, {
      logger,
      onLine: line => { if (!line.includes('frame=') && !line.includes('time=')) logger?.log?.(line); }
    });
    return;
  }

  // ── xfade transitions ────────────────────────────────────────────────────────
  // Get durations of each segment to calculate xfade offsets
  const td = Math.max(0.1, Math.min(1.5, transitionDuration));
  logger?.log?.(`   xfade: ${transition} × ${td}s between ${n} segments — measuring durations…`);

  const durations = [];
  for (const p of segmentPaths) {
    durations.push(await getSegmentDuration(p));
  }

  // Build filter_complex for chained xfade
  // [0:v][1:v]xfade=...:offset=D0-td[v01]; [v01][2:v]xfade=...:offset=(D0+D1-2*td)[v012]; ...
  // Audio: acrossfade between each pair
  const inputs = segmentPaths.flatMap(p => ['-i', p]);

  const vParts = [];
  const aParts = [];
  let cumulativeDur = 0;

  for (let i = 0; i < n - 1; i++) {
    const offset = Math.max(0.01, cumulativeDur + durations[i] - td);
    const vIn  = i === 0 ? `[${i}:v]` : `[v${i}]`;
    const vOut = i === n - 2 ? '[vout]' : `[v${i + 1}]`;
    vParts.push(`${vIn}[${i + 1}:v]xfade=transition=${transition}:duration=${td}:offset=${offset.toFixed(3)}${vOut}`);

    const aIn  = i === 0 ? `[${i}:a]` : `[a${i}]`;
    const aOut = i === n - 2 ? '[aout]' : `[a${i + 1}]`;
    aParts.push(`${aIn}[${i + 1}:a]acrossfade=d=${td}${aOut}`);

    cumulativeDur += durations[i] - td;
  }

  const filterComplex = [...vParts, ...aParts].join(';');

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', preset.preset, '-crf', String(preset.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', preset.audioBitrate,
  ];
  if (outputFormat === 'mp4' || outputFormat === 'mov') args.push('-movflags', '+faststart');
  args.push(outputPath);

  try {
    await runFfmpeg(args, {
      logger,
      onLine: line => { if (!line.includes('frame=') && !line.includes('time=')) logger?.log?.(line); }
    });
  } catch (xfadeErr) {
    // xfade can fail if clips have mismatched streams or are too short.
    // Fall back to simple concat so the pipeline always completes.
    logger?.log?.(`⚠️  xfade failed (${xfadeErr.message.slice(0, 120)}), falling back to concat…`);
    const fileListContent = segmentPaths.map(p => `file '${p.replace(/'/g, "'\"'\"'")}'`).join('\n');
    fs.writeFileSync(listPath, fileListContent);
    const concatArgs = [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', listPath, '-fflags', '+genpts',
      '-c:v', 'libx264', '-preset', preset.preset, '-crf', String(preset.crf),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', preset.audioBitrate,
    ];
    if (outputFormat === 'mp4' || outputFormat === 'mov') concatArgs.push('-movflags', '+faststart');
    concatArgs.push(outputPath);
    await runFfmpeg(concatArgs, {
      logger,
      onLine: line => { if (!line.includes('frame=') && !line.includes('time=')) logger?.log?.(line); }
    });
  }
}

function validateFile(file) {
  const filename = file.originalFilename || file.filename;
  const extension = path.extname(filename).toLowerCase().slice(1);

  if (!CONFIG.allowedFormats.includes(extension)) {
    throw new Error(`Unsupported format: ${extension}`);
  }
  if (file.size > LIMITS.maxVideoFileSizeBytes) {
    throw new Error(`File too large: ${filename}`);
  }
  return true;
}

async function handleVideoCombiner(req, res, { files, fields }, logger = console) {
  const log = (...args) => (logger?.log ? logger.log(...args) : console.log(...args));
  const err = (...args) => (logger?.error ? logger.error(...args) : console.error(...args));

  ensureDirectories();

  log('\n=== VIDEO COMBINER STARTED ===');

  // Parse config
  let config = {
    min_cut_duration: 2.0,
    max_cut_duration: 3.0,
    output_format: 'mp4',
    random_seed: null,
    segments_per_video: 1,
    target_total_duration: null,
    quality_preset: 'balanced',
    concurrency: 2
  };

  if (fields && fields.config) {
    const configStr = Array.isArray(fields.config) ? fields.config[0] : fields.config;
    try {
      config = { ...config, ...JSON.parse(configStr) };
    } catch (e) {
      err('Config parse error:', e.message);
      return res.status(400).json({ error: 'Invalid configuration', details: e.message });
    }
  }

  // Get videos
  const videos = files.videos || [];
  const videoArray = Array.isArray(videos) ? videos : (videos ? [videos] : []);

  if (videoArray.length === 0) {
    return res.status(400).json({ error: 'No video files provided' });
  }

  // Validate & enforce total size
  videoArray.forEach(validateFile);
  const totalBytes = videoArray.reduce((sum, v) => sum + (Number(v.size) || 0), 0);
  if (totalBytes > LIMITS.maxVideoTotalSizeBytes) {
    return res.status(413).json({
      error: 'Total upload too large',
      details: `Total bytes ${totalBytes} exceeds limit ${LIMITS.maxVideoTotalSizeBytes}`
    });
  }

  const preset = getVideoPreset(config.quality_preset);
  const outputFormat = String(config.output_format || 'mp4').toLowerCase();

  const sessionId = crypto.randomBytes(4).toString('hex');
  const sessionDir = path.join(CONFIG.tempDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    safeRm(sessionDir);
  };
  res.on('close', cleanup);
  res.on('finish', cleanup);

  try {
    log('');
    log('═════════════════════════════════════════════');
    log(`🎬 PROCESSING ${videoArray.length} VIDEO(S)`);
    log('═════════════════════════════════════════════');
    videoArray.forEach((v, i) => {
      log(`[${i + 1}/${videoArray.length}] ${v.originalFilename || v.filename} (${(v.size / 1024 / 1024).toFixed(2)}MB)`);
    });

    // Target total duration (optional)
    const targetTotal = toFiniteNumber(config.target_total_duration, null);
    const segsPerVideo = Math.max(1, Math.min(20, Math.floor(toFiniteNumber(config.segments_per_video, 1))));
    const targetPerSegment = (Number.isFinite(targetTotal) && targetTotal > 0)
      ? targetTotal / (videoArray.length * segsPerVideo)
      : null;

    // Prepare tasks
    const segmentTasks = [];

    for (let index = 0; index < videoArray.length; index++) {
      const video = videoArray[index];
      const filename = video.originalFilename || video.filename;
      const extension = path.extname(filename).slice(1);
      const inputPath = path.join(sessionDir, `input_${index}.${extension}`);

      fs.copyFileSync(video.filepath, inputPath);
      log(`\n📹 [${index + 1}/${videoArray.length}] Processing: ${filename}`);

      const duration = await runFfprobeDurationSeconds(inputPath, { logger });
      log(`   ⏱️ Duration: ${duration.toFixed(2)}s`);

      // Offset seed per video so each input has different randomness
      const seedForVideo = (config.random_seed === null || config.random_seed === undefined)
        ? null
        : (Number(config.random_seed) || 0) + index * 101;

      const cuts = generateRandomCuts(
        duration,
        config.min_cut_duration,
        config.max_cut_duration,
        seedForVideo,
        segsPerVideo,
        targetPerSegment
      );

      log(`   ✂️ Segments: ${cuts.length}`);

      for (let cutIndex = 0; cutIndex < cuts.length; cutIndex++) {
        const [start, end] = cuts[cutIndex];
        const segmentPath = path.join(sessionDir, `seg_${index}_${cutIndex}.mp4`);
        segmentTasks.push({
          index,
          cutIndex,
          inputPath,
          start,
          end,
          segmentPath
        });
        log(`      ${cutIndex + 1}. ${start.toFixed(1)}s - ${end.toFixed(1)}s`);
      }
    }

    if (segmentTasks.length === 0) {
      throw new Error('No segments extracted (empty task list)');
    }

    // Hardware-aware concurrency limits
    const maxSystemConcurrency = videoSegmentConcurrency;
    const userConcurrency = toFiniteNumber(config.concurrency, maxSystemConcurrency);
    const concurrency = Math.max(1, Math.min(
      maxSystemConcurrency,
      userConcurrency
    ));
    
    log(`\n⚡ Extracting ${segmentTasks.length} segment(s) with concurrency=${concurrency} (preset=${config.quality_preset || 'balanced'}, maxSystem=${maxSystemConcurrency})`);

    await mapWithConcurrency(segmentTasks, concurrency, async (task) => {
      const durationSeconds = Math.max(0.05, task.end - task.start);
      await extractSegment({
        inputPath: task.inputPath,
        startTime: task.start,
        durationSeconds,
        outputPath: task.segmentPath,
        preset,
        logger,
        orientation: config.orientation || 'landscape',
      });
      return true;
    });

    const allSegments = segmentTasks.map(t => t.segmentPath);

    log(`\n=== COMBINING SEGMENTS ===`);
    log(`Total segments: ${allSegments.length}`);

    const outputPath = path.join(CONFIG.outputDir, `combined_${sessionId}.${outputFormat}`);
    const listPath = path.join(sessionDir, `filelist_${Date.now()}.txt`);

    await combineVideos({
      segmentPaths: allSegments,
      listPath,
      outputPath,
      preset,
      logger,
      outputFormat,
      transition:         config.transition || 'none',
      transitionDuration: parseFloat(config.transition_duration) || 0.5,
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Output file not created');
    }
    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error('Output file is empty');
    }

    const contentType = getVideoContentTypeByExt(`.${outputFormat}`);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="combined_video.${outputFormat}"`);
    res.setHeader('Content-Length', stats.size);

    const readStream = fs.createReadStream(outputPath);
    readStream.on('error', (streamErr) => {
      err('Stream error:', streamErr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream output video' });
      } else {
        res.destroy(streamErr);
      }
    });

    readStream.pipe(res);

    log('=== Video Combiner Complete ===');
  } catch (e) {
    err('Video processing error:', e);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Video processing failed',
        details: e.message
      });
    }
  }
}

module.exports = { handleVideoCombiner, combineVideos, extractSegment, getSegmentDuration, CONFIG };
