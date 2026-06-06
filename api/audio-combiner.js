// Audio (voiceover) combiner API handler
// Combines audio clips with random pauses and returns a combined audio file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { LIMITS } = require('./app-config');
const { runFfmpeg } = require('./ffmpeg');
const { safeRm } = require('./http-utils');

const AUDIO_CONFIG = {
  allowedFormats: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg'],
  tempDir: path.join(__dirname, '../temp_audio'),
  outputDir: path.join(__dirname, '../output')
};

function ensureAudioDirectories() {
  [AUDIO_CONFIG.tempDir, AUDIO_CONFIG.outputDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function toNumberOrDefault(val, fallback) {
  const num = parseFloat(val);
  return Number.isFinite(num) ? num : fallback;
}

function createSeededRandom(seed) {
  if (seed === null || seed === undefined) return Math.random;
  let s = Number(seed) || 0;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function validateAudioFile(file) {
  const filename = file.originalFilename || file.filename;
  const extension = path.extname(filename).toLowerCase().slice(1);

  if (!AUDIO_CONFIG.allowedFormats.includes(extension)) {
    throw new Error(`Unsupported audio format: ${extension}`);
  }

  if (file.size > LIMITS.maxAudioFileSizeBytes) {
    throw new Error(`Audio file too large: ${filename}`);
  }

  return true;
}

async function normalizeAudio(inputPath, outputPath, logger) {
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'pcm_s16le',
    outputPath
  ], { logger });
}

async function createSilence(durationSeconds, outputPath, logger) {
  await runFfmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', String(durationSeconds),
    '-c:a', 'pcm_s16le',
    outputPath
  ], { logger });
}

function generateRandomPauses(count, minPause, maxPause, randomSeed) {
  const random = createSeededRandom(randomSeed);
  const pauses = [];
  for (let i = 0; i < count; i++) {
    const pause = minPause + random() * (maxPause - minPause);
    pauses.push(pause);
  }
  return pauses;
}

async function handleAudioCombiner(req, res, { files, fields }, logger = console) {
  const log = (...args) => (logger?.log ? logger.log(...args) : console.log(...args));
  const error = (...args) => (logger?.error ? logger.error(...args) : console.error(...args));

  ensureAudioDirectories();

  log('\n=== AUDIO VOICEOVER COMBINER STARTED ===');

  const audios = files.audios || [];
  const audioArray = Array.isArray(audios) ? audios : (audios ? [audios] : []);

  if (audioArray.length === 0) {
    return res.status(400).json({ error: 'No audio files provided' });
  }

  audioArray.forEach(validateAudioFile);
  const totalBytes = audioArray.reduce((sum, a) => sum + (Number(a.size) || 0), 0);
  if (totalBytes > LIMITS.maxAudioTotalSizeBytes) {
    return res.status(413).json({
      error: 'Total upload too large',
      details: `Total bytes ${totalBytes} exceeds limit ${LIMITS.maxAudioTotalSizeBytes}`
    });
  }

  log(`🎧 Received ${audioArray.length} audio file(s)`);
  audioArray.forEach((a, i) => {
    log(`   [${i + 1}] ${a.originalFilename || a.filename} (${(a.size / 1024 / 1024).toFixed(2)}MB)`);
  });

  // Parse configuration
  let config = {
    min_pause_duration: 0.5,
    max_pause_duration: 2.0,
    output_format: 'mp3',
    random_seed: null
  };

  if (fields && fields.config) {
    const configStr = Array.isArray(fields.config) ? fields.config[0] : fields.config;
    try {
      config = { ...config, ...JSON.parse(configStr) };
    } catch (e) {
      error('Audio config parse error:', e.message);
      return res.status(400).json({ error: 'Invalid audio configuration', details: e.message });
    }
  }

  // Harden config
  config.min_pause_duration = Math.max(0, toNumberOrDefault(config.min_pause_duration, 0.5));
  config.max_pause_duration = toNumberOrDefault(config.max_pause_duration, 2.0);
  if (!Number.isFinite(config.max_pause_duration) || config.max_pause_duration < config.min_pause_duration) {
    config.max_pause_duration = config.min_pause_duration + 0.5;
  }
  config.random_seed = config.random_seed !== null && config.random_seed !== undefined
    ? toNumberOrDefault(config.random_seed, null)
    : null;

  log('⚙️ Audio Config:', config);

  const sessionId = crypto.randomBytes(4).toString('hex');
  const sessionDir = path.join(AUDIO_CONFIG.tempDir, sessionId);
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
    const sequencePaths = [];

    // Normalize all inputs
    for (let index = 0; index < audioArray.length; index++) {
      const audio = audioArray[index];
      const filename = audio.originalFilename || audio.filename;
      const extension = path.extname(filename).slice(1);
      const inputPath = path.join(sessionDir, `input_${index}.${extension}`);
      const normalizedPath = path.join(sessionDir, `norm_${index}.wav`);

      fs.copyFileSync(audio.filepath, inputPath);
      log(`\n🎙️ [${index + 1}/${audioArray.length}] Processing: ${filename}`);

      await normalizeAudio(inputPath, normalizedPath, logger);
      sequencePaths.push(normalizedPath);
    }

    // Insert pauses between clips
    if (sequencePaths.length > 1) {
      const pauses = generateRandomPauses(
        sequencePaths.length - 1,
        config.min_pause_duration,
        config.max_pause_duration,
        config.random_seed
      );

      log('\n=== GENERATING PAUSES ===');
      const withPauses = [];
      for (let i = 0; i < sequencePaths.length; i++) {
        withPauses.push(sequencePaths[i]);
        if (i < sequencePaths.length - 1) {
          const pauseDuration = pauses[i];
          const pausePath = path.join(sessionDir, `pause_${i}.wav`);
          log(`   Pause ${i + 1}: ${pauseDuration.toFixed(2)}s`);
          await createSilence(pauseDuration, pausePath, logger);
          withPauses.push(pausePath);
        }
      }
      sequencePaths.length = 0;
      Array.prototype.push.apply(sequencePaths, withPauses);
    }

    if (sequencePaths.length === 0) {
      throw new Error('No audio segments to combine');
    }

    // Create concat file
    const listPath = path.join(sessionDir, `filelist_${Date.now()}.txt`);
    const fileListContent = sequencePaths
      .map(p => `file '${p.replace(/'/g, "'\"'\"'")}'`)
      .join('\n');
    fs.writeFileSync(listPath, fileListContent);

    const outExt = String(config.output_format || 'mp3').toLowerCase();
    const outputPath = path.join(AUDIO_CONFIG.outputDir, `voiceover_${sessionId}.${outExt}`);

    log('\n=== COMBINING AUDIO SEGMENTS ===');
    log(`Total segments (including pauses): ${sequencePaths.length}`);
    log(`Output path: ${outputPath}`);

    let contentType;
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];

    if (outExt === 'wav') {
      args.push('-c:a', 'pcm_s16le');
      contentType = 'audio/wav';
    } else {
      // default to mp3
      args.push('-c:a', 'libmp3lame', '-q:a', '2');
      contentType = 'audio/mpeg';
    }

    args.push(outputPath);

    await runFfmpeg(args, {
      logger,
      onLine: (line) => {
        if (line.includes('frame=') || line.includes('time=')) return;
        logger?.log?.(line);
      }
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Output audio file not created');
    }
    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error('Output audio file is empty');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="combined_voiceover.${outExt}"`);
    res.setHeader('Content-Length', stats.size);

    const readStream = fs.createReadStream(outputPath);
    readStream.on('error', (streamErr) => {
      error('Audio stream error:', streamErr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream output audio' });
      } else {
        res.destroy(streamErr);
      }
    });

    readStream.pipe(res);

    log('=== Audio Voiceover Combiner Complete ===');
  } catch (e) {
    error('Audio processing error:', e);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Audio processing failed',
        details: e.message
      });
    }
  }
}

module.exports = { handleAudioCombiner, AUDIO_CONFIG };
