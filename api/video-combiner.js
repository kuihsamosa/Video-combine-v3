// Video combiner API handler
// Combines N randomized segments per input video and returns a combined output.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { LIMITS, getVideoPreset } = require('./app-config');
const { runFfprobeDurationSeconds, runFfmpeg } = require('./ffmpeg');
const { getVideoContentTypeByExt, safeRm } = require('./http-utils');

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

function buildScalePadFilter() {
  return 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
}

async function extractSegment({ inputPath, startTime, durationSeconds, outputPath, preset, logger }) {
  const args = [
    '-y',
    '-ss', String(startTime),
    '-i', inputPath,
    '-t', String(durationSeconds),
    '-vf', buildScalePadFilter(),
    '-r', '25',
    '-c:v', 'libx264',
    '-preset', preset.preset,
    '-crf', String(preset.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', preset.audioBitrate,
    '-avoid_negative_ts', '1',
    '-movflags', '+faststart',
    outputPath
  ];

  await runFfmpeg(args, {
    logger,
    onLine: (line) => {
      if (line.includes('frame=') || line.includes('time=')) return; // noisy
      logger?.log?.(line);
    }
  });
}

async function combineVideos({ segmentPaths, listPath, outputPath, preset, logger, outputFormat }) {
  const fileListContent = segmentPaths
    .map(p => `file '${p.replace(/'/g, "'\"'\"'")}'`)
    .join('\n');

  fs.writeFileSync(listPath, fileListContent);
  logger?.log?.(`[FFMPEG] Combining ${segmentPaths.length} segments into: ${outputPath}`);

  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-fflags', '+genpts',
    '-c:v', 'libx264',
    '-preset', preset.preset,
    '-crf', String(preset.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', preset.audioBitrate,
  ];

  // faststart only applies to mp4/mov (harmless elsewhere but keep explicit)
  if (outputFormat === 'mp4' || outputFormat === 'mov') {
    args.push('-movflags', '+faststart');
  }

  args.push(outputPath);

  await runFfmpeg(args, {
    logger,
    onLine: (line) => {
      if (line.includes('frame=') || line.includes('time=')) return;
      logger?.log?.(line);
    }
  });
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

    const concurrency = Math.max(1, Math.min(6, Math.floor(toFiniteNumber(config.concurrency, 2))));
    log(`\n⚡ Extracting ${segmentTasks.length} segment(s) with concurrency=${concurrency} (preset=${config.quality_preset || 'balanced'})`);

    await mapWithConcurrency(segmentTasks, concurrency, async (task) => {
      const durationSeconds = Math.max(0.05, task.end - task.start);
      await extractSegment({
        inputPath: task.inputPath,
        startTime: task.start,
        durationSeconds,
        outputPath: task.segmentPath,
        preset,
        logger
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
      outputFormat
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

module.exports = { handleVideoCombiner, CONFIG };
