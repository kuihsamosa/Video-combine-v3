// Express Server for Video Combiner
// Serves a static browser UI + provides local API endpoints that run FFmpeg.

// Load .env if present (GROQ_API_KEY, PORT, OMNIVOICE_URL, etc.)
try {
  const envPath = require('path').join(__dirname, '../.env');
  if (require('fs').existsSync(envPath)) {
    require('fs').readFileSync(envPath, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .forEach(l => {
        const eq = l.indexOf('=');
        if (eq > 0) {
          const k = l.slice(0, eq).trim();
          const v = l.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
          if (!(k in process.env)) process.env[k] = v;
        }
      });
  }
} catch (_) {}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const formidable = require('formidable');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { LIMITS } = require('./app-config');
const { handleVideoCombiner } = require('./video-combiner');
const { handleAudioCombiner } = require('./audio-combiner');
const { handleMuxCombiner } = require('./mux-combiner');
const { handleAnnotation, handleAnnotationRender } = require('./annotator');
const { generateScript, availableModels } = require('./script-generator');
const { brainstormIdeas, validateIdea, refineIdea } = require('./planner');
const schedulerModule = require('./scheduler');
const { findFootageForScenes, clearAllFootage, FOOTAGE_DIR } = require('./footage-finder');
const { IMAGE_DIR } = require('./image-finder');
const { preprocessTTS: _preprocessTTS, chunkTTS: _chunkTTS, stitchWavBuffers, findDataOffset } = require('./tts-utils');
const { burnCaptions, TEMPLATES: CAPTION_TEMPLATES } = require('./caption-generator');
const { searchJamendo, searchFreesound, downloadTrack, mixMusicUnderVideo, clearAllMusic, MUSIC_DIR } = require('./music-finder');
const { getYouTubeInfo, downloadYouTube, listYouTubeFiles, clearYouTubeCache, YT_DIR } = require('./youtube-downloader');
const { openRealBrowser, extractFromBrowser, cookiesExist, cookieStatus, clearCookies, COOKIE_PATH } = require('./youtube-auth');
const { searchYouTube } = require('./youtube-search');

const app = express();
const PORT = process.env.PORT || 8080;

const TEMP_DIRS = {
  temp: path.join(__dirname, '../temp'),
  temp_mux: path.join(__dirname, '../temp_mux'),
  temp_audio: path.join(__dirname, '../temp_audio'),
  output: path.join(__dirname, '../output')
};

const logStreams = new Map();
const sessionLogs = new Map();

function getSessionEmitter(sessionId) {
  if (!sessionId) return null;
  if (!logStreams.has(sessionId)) {
    logStreams.set(sessionId, new EventEmitter());
  }
  return logStreams.get(sessionId);
}

function appendSessionLog(sessionId, message) {
  if (!sessionId) return;
  const existing = sessionLogs.get(sessionId) || [];
  existing.push(message);
  if (existing.length > 1000) {
    existing.shift();
  }
  sessionLogs.set(sessionId, existing);
}

function getSessionLogs(sessionId) {
  return sessionLogs.get(sessionId) || [];
}

function emitSessionLog(sessionId, message) {
  console.log(message);
  if (!sessionId) return;
  appendSessionLog(sessionId, message);
  const emitter = getSessionEmitter(sessionId);
  emitter?.emit('log', message);
}

function cleanupSession(sessionId) {
  if (!sessionId) return;
  const emitter = logStreams.get(sessionId);
  if (emitter) {
    emitter.removeAllListeners();
    logStreams.delete(sessionId);
  }
  if (sessionLogs.has(sessionId)) {
    sessionLogs.delete(sessionId);
  }
}

function formatSseMessage(message) {
  return (
    message
      .split('\n')
      .map(line => `data: ${line}`)
      .join('\n') + '\n\n'
  );
}

function createSessionLogger(sessionId) {
  if (!sessionId) return console;
  return {
    log: (...args) => emitSessionLog(sessionId, args.join(' ')),
    error: (...args) => emitSessionLog(sessionId, args.join(' '))
  };
}

function getDirSizeBytes(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return 0;
    const stats = fs.statSync(targetPath);
    if (stats.isFile()) return stats.size;
    if (!stats.isDirectory()) return 0;

    let total = 0;
    const stack = [targetPath];
    while (stack.length) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        const entryStats = fs.statSync(fullPath);
        if (entryStats.isDirectory()) {
          stack.push(fullPath);
        } else {
          total += entryStats.size;
        }
      }
    }
    return total;
  } catch (err) {
    console.error('dir size error:', err);
    return 0;
  }
}

function getDirManifest(targetPath) {
  const manifest = { exists: false, files: [], total_bytes: 0 };
  try {
    if (!fs.existsSync(targetPath)) return manifest;
    manifest.exists = true;
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(targetPath, entry.name);
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) continue;
      manifest.files.push({
        name: entry.name,
        size: stats.size,
        modified: stats.mtimeMs
      });
      manifest.total_bytes += stats.size;
    }
  } catch (err) {
    console.error('dir manifest error:', err);
  }
  // Sort by newest first for quick triage
  manifest.files.sort((a, b) => b.modified - a.modified);
  return manifest;
}

// CORS is disabled by default (same-origin). To enable cross-origin access, set:
//   CORS_ORIGIN='http://example.com' (comma-separated allowed origins) or CORS_ORIGIN='*'
if (process.env.CORS_ORIGIN) {
  const raw = String(process.env.CORS_ORIGIN).trim();
  const origin = raw === '*' ? '*' : raw.split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors({ origin }));
}

// Middleware
app.use(express.json({ limit: '50mb' }));

// Serve static UI assets
app.use('/public', express.static(path.join(__dirname, '../public')));
app.use(express.static(path.join(__dirname, '..')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Video Combiner API is running' });
});

// Disk usage endpoint (temp/output folders)
app.get('/api/disk-usage', (req, res) => {
  try {
    const sizes = {};
    Object.entries(TEMP_DIRS).forEach(([key, dir]) => {
      sizes[key] = getDirSizeBytes(dir);
    });
    res.json({
      sizes,
      free_bytes: os.freemem(), // system free memory (approx), disk free not portable without exec
    });
  } catch (err) {
    console.error('Disk usage error:', err);
    res.status(500).json({ error: 'Failed to read disk usage', details: err.message });
  }
});

// Cleanup endpoint: clear temp/output folders to free space
app.post('/api/cleanup', (req, res) => {
  const bodyTargets = (req.body && req.body.targets) || [];
  const targets = Array.isArray(bodyTargets) && bodyTargets.length > 0
    ? bodyTargets.filter(t => TEMP_DIRS[t])
    : Object.keys(TEMP_DIRS);

  try {
    targets.forEach(key => {
      const dir = TEMP_DIRS[key];
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.mkdirSync(dir, { recursive: true });
    });
    res.json({ ok: true, cleared: targets });
  } catch (err) {
    console.error('Cleanup error:', err);
    res.status(500).json({ error: 'Cleanup failed', details: err.message });
  }
});

// ── Clear ALL temp files (footage cache + pipeline temp dirs + caps_* in os.tmpdir) ──
app.post('/api/clear-temp', (req, res) => {
  const logger = { log: m => console.log(m), error: m => console.error(m) };
  const report = { footage: null, pipeline: [], caps: 0, errors: [] };

  // 1. Stock footage cache
  try {
    report.footage = clearAllFootage(logger);
  } catch (e) { report.errors.push(`footage: ${e.message}`); }

  // 1b. Music cache
  try {
    report.music = clearAllMusic(logger);
  } catch (e) { report.errors.push(`music: ${e.message}`); }

  // 1c. YouTube download cache
  try {
    report.youtube = clearYouTubeCache(logger);
  } catch (e) { report.errors.push(`youtube: ${e.message}`); }

  // 2. Pipeline temp dirs (temp, temp_mux, temp_audio, output)
  for (const [key, dir] of Object.entries(TEMP_DIRS)) {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      report.pipeline.push(key);
    } catch (e) { report.errors.push(`${key}: ${e.message}`); }
  }

  // 3. Caption temp dirs in os.tmpdir (caps_*)
  try {
    const tmp = os.tmpdir();
    for (const f of fs.readdirSync(tmp)) {
      if (/^caps_(in|out|[0-9]+)/.test(f)) {
        try { fs.rmSync(path.join(tmp, f), { recursive: true, force: true }); report.caps++; } catch(_) {}
      }
    }
  } catch (_) {}

  res.json({ ok: true, ...report });
});

// Temp analyzer endpoint: list recent files and sizes for each temp bucket
app.get('/api/temp-analyzer', (req, res) => {
  try {
    const manifest = {};
    Object.entries(TEMP_DIRS).forEach(([key, dir]) => {
      manifest[key] = getDirManifest(dir);
    });
    res.json({ ok: true, manifest });
  } catch (err) {
    console.error('Temp analyzer error:', err);
    res.status(500).json({ error: 'Analyzer failed', details: err.message });
  }
});

// Real-time log stream for browser clients
app.get('/api/log-stream/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId' });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const emitter = getSessionEmitter(sessionId);
  const send = message => res.write(formatSseMessage(message));
  emitter.on('log', send);
  send(`🔌 Connected to session ${sessionId}`);

  const keepAlive = setInterval(() => {
    res.write(':\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    if (emitter) {
      emitter.off('log', send);
    }
    res.end();
  });
});

// Annotation endpoint: upload a single combined video and return generated annotations
app.post('/api/annotate', async (req, res) => {
  try {
    const annotateUploadDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(annotateUploadDir)) {
      fs.mkdirSync(annotateUploadDir, { recursive: true });
    }

    const form = formidable({
      uploadDir: annotateUploadDir,
      keepExtensions: true,
      maxFileSize: LIMITS.maxAnnotationFileSizeBytes,
      maxFiles: 2,
      multiples: true
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('Annotation form parsing error:', err);
        return res.status(400).json({
          error: 'Annotation upload failed',
          details: err.message
        });
      }

      const sessionId = crypto.randomBytes(4).toString('hex');
      const logger = createSessionLogger(sessionId);

      try {
        await handleAnnotation(req, res, { files, fields }, logger);
      } catch (handlerError) {
        logger.error(`❌ Annotation failed: ${handlerError.message}`);
      } finally {
        setTimeout(() => cleanupSession(sessionId), 10000);
      }
    });
  } catch (error) {
    console.error('Annotation endpoint error:', error);
    res.status(500).json({
      error: 'Annotation server error',
      details: error.message
    });
  }
});

// Annotation render endpoint: burn annotations JSON into provided video
app.post('/api/annotate/render', async (req, res) => {
  try {
    const annotateUploadDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(annotateUploadDir)) {
      fs.mkdirSync(annotateUploadDir, { recursive: true });
    }

    const form = formidable({
      uploadDir: annotateUploadDir,
      keepExtensions: true,
      maxFileSize: LIMITS.maxAnnotationFileSizeBytes,
      maxFiles: 1,
      multiples: false
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('Annotation render form parsing error:', err);
        return res.status(400).json({
          error: 'Annotation render upload failed',
          details: err.message
        });
      }

      const sessionId = crypto.randomBytes(4).toString('hex');
      const logger = createSessionLogger(sessionId);

      try {
        await handleAnnotationRender(req, res, { files, fields }, logger);
      } catch (handlerError) {
        logger.error(`❌ Annotation render failed: ${handlerError.message}`);
      } finally {
        setTimeout(() => cleanupSession(sessionId), 10000);
      }
    });
  } catch (error) {
    console.error('Annotation render endpoint error:', error);
    res.status(500).json({
      error: 'Annotation render server error',
      details: error.message
    });
  }
});

// Log buffer fetch endpoint (fallback when SSE is not available)
app.get('/api/logs/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId' });
    return;
  }
  const logs = getSessionLogs(sessionId);
  res.json({ logs });
});

// Debug endpoint to check file uploads
app.post('/api/debug-upload', async (req, res) => {
  try {
    const form = formidable({
      uploadDir: path.join(__dirname, '../temp'),
      keepExtensions: true,
      maxFileSize: LIMITS.maxVideoFileSizeBytes,
      maxTotalFileSize: LIMITS.maxVideoTotalSizeBytes,
      maxFiles: LIMITS.maxVideoFiles,
      multiples: true
    });

    form.parse(req, (err, fields, files) => {
      if (err) {
        return res.json({ error: err.message });
      }

      console.log('\n=== DEBUG UPLOAD ===');
      console.log('Files keys:', Object.keys(files));
      
      const videos = files.videos || [];
      const videoArray = Array.isArray(videos) ? videos : (videos ? [videos] : []);
      
      console.log(`Total videos received: ${videoArray.length}`);
      videoArray.forEach((v, i) => {
        console.log(`  [${i+1}] ${v.originalFilename || v.filename} - ${v.size} bytes`);
      });

      res.json({
        videosReceived: videoArray.length,
        videosList: videoArray.map(v => ({
          name: v.originalFilename || v.filename,
          size: v.size
        }))
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mux endpoint: combine already-combined video + voiceover into final content
app.post('/api/mux-combiner', async (req, res) => {
  try {
    const muxUploadDir = path.join(__dirname, '../temp_mux');
    if (!fs.existsSync(muxUploadDir)) {
      fs.mkdirSync(muxUploadDir, { recursive: true });
    }

    const form = formidable({
      uploadDir: muxUploadDir,
      keepExtensions: true,
      maxFileSize: LIMITS.maxMuxFileSizeBytes,
      maxTotalFileSize: LIMITS.maxMuxFileSizeBytes * 2,
      maxFiles: 2,
      multiples: false
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('Mux form parsing error:', err);
        return res.status(400).json({
          error: 'Mux upload failed',
          details: err.message
        });
      }

      let sessionId = null;
      if (fields && fields.config) {
        const configStr = Array.isArray(fields.config) ? fields.config[0] : fields.config;
        try {
          const parsedConfig = JSON.parse(configStr);
          sessionId = parsedConfig.session_id || null;
        } catch (parseError) {
          console.error('Mux Session ID parse error:', parseError.message);
        }
      }

      if (!sessionId) {
        sessionId = crypto.randomBytes(4).toString('hex');
      }

      const logger = createSessionLogger(sessionId);

      try {
        await handleMuxCombiner(req, res, { files, fields }, logger);
        emitSessionLog(sessionId, '✅ Mux session complete – closing stream soon');
      } catch (handlerError) {
        emitSessionLog(sessionId, `❌ Mux processing failed: ${handlerError.message}`);
      } finally {
        setTimeout(() => cleanupSession(sessionId), 10000);
      }
    });

  } catch (error) {
    console.error('Mux endpoint error:', error);
    res.status(500).json({
      error: 'Mux server error',
      details: error.message
    });
  }
});

// Audio voiceover combining endpoint
app.post('/api/audio-combiner', async (req, res) => {
  try {
    const audioUploadDir = path.join(__dirname, '../temp_audio');
    if (!fs.existsSync(audioUploadDir)) {
      fs.mkdirSync(audioUploadDir, { recursive: true });
    }

    const form = formidable({
      uploadDir: audioUploadDir,
      keepExtensions: true,
      maxFileSize: LIMITS.maxAudioFileSizeBytes,
      maxTotalFileSize: LIMITS.maxAudioTotalSizeBytes,
      maxFiles: LIMITS.maxAudioFiles,
      multiples: true
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('Audio form parsing error:', err);
        return res.status(400).json({
          error: 'Audio file upload failed',
          details: err.message
        });
      }

      let sessionId = null;
      if (fields && fields.config) {
        const configStr = Array.isArray(fields.config) ? fields.config[0] : fields.config;
        try {
          const parsedConfig = JSON.parse(configStr);
          sessionId = parsedConfig.session_id || null;
        } catch (parseError) {
          console.error('Audio Session ID parse error:', parseError.message);
        }
      }

      if (!sessionId) {
        sessionId = crypto.randomBytes(4).toString('hex');
      }

      const logger = createSessionLogger(sessionId);

      try {
        await handleAudioCombiner(req, res, { files, fields }, logger);
        emitSessionLog(sessionId, '✅ Audio session complete – closing stream soon');
      } catch (handlerError) {
        emitSessionLog(sessionId, `❌ Audio processing failed: ${handlerError.message}`);
      } finally {
        setTimeout(() => cleanupSession(sessionId), 10000);
      }
    });

  } catch (error) {
    console.error('Audio endpoint error:', error);
    res.status(500).json({
      error: 'Audio server error',
      details: error.message
    });
  }
});

// Main video processing endpoint
app.post('/api/video-combiner', async (req, res) => {
  try {
    // Ensure temp directory exists before formidable writes files
    const videoUploadDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(videoUploadDir)) {
      fs.mkdirSync(videoUploadDir, { recursive: true });
    }

    // Use formidable to parse multipart form data
    const form = formidable({
      uploadDir: videoUploadDir,
      keepExtensions: true,
      maxFileSize: LIMITS.maxVideoFileSizeBytes,
      maxTotalFileSize: LIMITS.maxVideoTotalSizeBytes,
      maxFiles: LIMITS.maxVideoFiles,
      multiples: true
    });

    // Parse the incoming form
    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('Form parsing error:', err);
        return res.status(400).json({ 
          error: 'File upload failed',
          details: err.message 
        });
      }

      let sessionId = null;
      if (fields && fields.config) {
        const configStr = Array.isArray(fields.config) ? fields.config[0] : fields.config;
        try {
          const parsedConfig = JSON.parse(configStr);
          sessionId = parsedConfig.session_id || null;
        } catch (parseError) {
          console.error('Session ID parse error:', parseError.message);
        }
      }

      if (!sessionId) {
        sessionId = crypto.randomBytes(4).toString('hex');
      }

      const logger = createSessionLogger(sessionId);

      try {
        await handleVideoCombiner(req, res, { files, fields }, logger);
        emitSessionLog(sessionId, '✅ Session complete – closing stream soon');
      } catch (handlerError) {
        emitSessionLog(sessionId, `❌ Processing failed: ${handlerError.message}`);
      } finally {
        setTimeout(() => cleanupSession(sessionId), 10000);
      }
    });

  } catch (error) {
    console.error('Endpoint error:', error);
    res.status(500).json({ 
      error: 'Server error',
      details: error.message 
    });
  }
});

// Script generation via Groq LLM
// List available AI models based on which keys are configured
app.get('/api/models', (req, res) => {
  const models = availableModels(process.env);
  res.json({ ok: true, models });
});

app.post('/api/generate-script', async (req, res) => {
  // Check that at least one provider key is available
  const models = availableModels(process.env);
  if (!models.length) {
    return res.status(500).json({ ok: false, error: 'No AI provider keys configured. Add GROQ_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, or OPENROUTER_API_KEY to your .env file.' });
  }

  const {
    topic,
    niche = 'general',
    tone = 'informative',
    duration_minutes = 2,
    style = 'storytelling',
    model = 'llama-3.3-70b-versatile'
  } = req.body || {};

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ ok: false, error: 'topic is required' });
  }

  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger = createSessionLogger(sessionId);

  try {
    logger.log(`🎬 Generating script: "${topic}" | ${duration_minutes}min | ${model}`);
    const result = await generateScript({ topic, niche, tone, duration_minutes, style, model, env: process.env }, logger);
    res.json({ ok: true, session_id: sessionId, ...result });
  } catch (err) {
    logger.error(`❌ Script generation failed: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message });
  } finally {
    setTimeout(() => cleanupSession(sessionId), 30_000);
  }
});

// ── Content Planner ───────────────────────────────────────────────────────────

// Brainstorm: generate video ideas
app.post('/api/planner/brainstorm', async (req, res) => {
  const { niche, platform = 'YouTube', goal, count = 8, tone, avoid, model, use_trends } = req.body || {};
  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger = createSessionLogger(sessionId);
  try {
    const ideas = await brainstormIdeas(
      { niche, platform, goal, count, tone, avoid, model, use_trends: use_trends !== false, env: process.env },
      logger,
    );
    res.json({ ok: true, session_id: sessionId, ideas });
  } catch (err) {
    logger.error(`❌ Brainstorm: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message });
  } finally {
    setTimeout(() => cleanupSession(sessionId), 30_000);
  }
});

app.post('/api/planner/validate', async (req, res) => {
  const { idea, niche, platform = 'YouTube', model } = req.body || {};
  if (!idea?.title) return res.status(400).json({ ok: false, error: 'idea object with title required' });
  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger = createSessionLogger(sessionId);
  try {
    const validation = await validateIdea(idea, { niche, platform, model, env: process.env }, logger);
    res.json({ ok: true, session_id: sessionId, validation });
  } catch (err) {
    logger.error(`❌ Validate: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message });
  } finally {
    setTimeout(() => cleanupSession(sessionId), 30_000);
  }
});

app.post('/api/planner/refine', async (req, res) => {
  const { idea, validation, platform = 'YouTube', model } = req.body || {};
  if (!idea?.title) return res.status(400).json({ ok: false, error: 'idea + validation required' });
  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger = createSessionLogger(sessionId);
  try {
    const refined = await refineIdea(idea, validation || {}, { platform, model, env: process.env }, logger);
    res.json({ ok: true, session_id: sessionId, idea: refined });
  } catch (err) {
    logger.error(`❌ Refine: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message });
  } finally {
    setTimeout(() => cleanupSession(sessionId), 30_000);
  }
});

// ── Scheduler ─────────────────────────────────────────────────────────────────

// List all jobs
app.get('/api/scheduler/jobs', (req, res) => {
  res.json({ ok: true, jobs: schedulerModule.loadJobs() });
});

// Create job
app.post('/api/scheduler/jobs', (req, res) => {
  try {
    const job = schedulerModule.createJob(req.body || {});
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Update job
app.put('/api/scheduler/jobs/:id', (req, res) => {
  const job = schedulerModule.updateJob(req.params.id, req.body || {});
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
});

// Delete job
app.delete('/api/scheduler/jobs/:id', (req, res) => {
  schedulerModule.deleteJob(req.params.id);
  res.json({ ok: true });
});

// Toggle enabled
app.post('/api/scheduler/jobs/:id/toggle', (req, res) => {
  const job = schedulerModule.getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  const updated = schedulerModule.updateJob(req.params.id, { enabled: !job.enabled });
  res.json({ ok: true, job: updated });
});

// Manual trigger
app.post('/api/scheduler/jobs/:id/run', async (req, res) => {
  const job = schedulerModule.getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  if (job.status === 'running') return res.status(409).json({ ok: false, error: 'Job already running' });
  // Kick off async — return the runId immediately so client can subscribe to logs
  const runId = crypto.randomBytes(4).toString('hex');
  // Patch the runId into the job before runJob picks it up
  schedulerModule.runJob(job.id).catch(console.error);
  res.json({ ok: true, message: 'Job triggered', job_id: job.id });
});

// Cancel a running job
app.post('/api/scheduler/jobs/:id/cancel', async (req, res) => {
  try {
    const result = await schedulerModule.cancelJob(req.params.id);
    res.json({ ok: true, message: 'Job cancelled', job: result.job });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// SSE: live logs for a running job
app.get('/api/scheduler/jobs/:id/logs', (req, res) => {
  const job = schedulerModule.getJob(req.params.id);
  if (!job) return res.status(404).end();
  const runId = job.current_run_id || req.query.run_id;
  if (!runId) return res.status(404).json({ ok: false, error: 'No active run' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  schedulerModule.subscribeRunLog(runId, res);
  req.on('close', () => schedulerModule.unsubscribeRunLog(runId, res));
});

// ── #22 Script Archive endpoints ─────────────────────────────────────────────
const scriptStore = require('./script-store');
app.get('/api/scripts', (req, res) => {
  const { job_id } = req.query;
  res.json({ ok: true, scripts: scriptStore.listScripts({ jobId: job_id }) });
});
app.get('/api/scripts/:id', (req, res) => {
  const s = scriptStore.getScript(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, script: s });
});
app.delete('/api/scripts/:id', (req, res) => {
  scriptStore.deleteScript(req.params.id);
  res.json({ ok: true });
});

// ── #25 Job Templates ─────────────────────────────────────────────────────────
const TEMPLATES_FILE = path.join(__dirname, '../job-templates.json');
function loadTemplates() { try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')) || []; } catch(_) { return []; } }
function saveTemplates(t) { fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(t, null, 2)); }

app.get('/api/scheduler/templates', (req, res) => {
  res.json({ ok: true, templates: loadTemplates() });
});
app.post('/api/scheduler/templates', (req, res) => {
  const { name, job_id } = req.body || {};
  const job = job_id ? schedulerModule.getJob(job_id) : req.body?.config;
  if (!job) return res.status(400).json({ ok: false, error: 'job_id or config required' });
  const templates = loadTemplates();
  const tmpl = {
    id:         require('crypto').randomBytes(4).toString('hex'),
    name:       name || job.name || 'Template',
    created_at: new Date().toISOString(),
    config:     { ...job, id: undefined, status: undefined, run_history: undefined, created_at: undefined },
  };
  templates.push(tmpl);
  saveTemplates(templates);
  res.json({ ok: true, template: tmpl });
});
app.delete('/api/scheduler/templates/:id', (req, res) => {
  saveTemplates(loadTemplates().filter(t => t.id !== req.params.id));
  res.json({ ok: true });
});
app.post('/api/scheduler/templates/:id/spawn', (req, res) => {
  const tmpl = loadTemplates().find(t => t.id === req.params.id);
  if (!tmpl) return res.status(404).json({ ok: false, error: 'template not found' });
  const overrides = req.body || {};
  const job = schedulerModule.createJob({ ...tmpl.config, ...overrides });
  res.json({ ok: true, job });
});

// ── #27 Social posting status ─────────────────────────────────────────────────
app.get('/api/social/status', (req, res) => {
  const { tiktokConfigured, instagramConfigured } = require('./tiktok-uploader');
  res.json({
    ok: true,
    tiktok:    { configured: tiktokConfigured() },
    instagram: { configured: instagramConfigured() },
  });
});

// ── #28 YouTube stats — manual refresh ────────────────────────────────────────
app.post('/api/scheduler/jobs/:id/fetch-stats', async (req, res) => {
  const job    = schedulerModule.getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'not found' });
  const apiKey = process.env.YOUTUBE_API_KEY;
  const vidId  = job._last_youtube_video_id;
  if (!apiKey || !vidId) return res.json({ ok: false, error: 'YOUTUBE_API_KEY or youtube video ID missing' });
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${vidId}&key=${apiKey}`);
    const d = await r.json();
    const stats = d?.items?.[0]?.statistics;
    if (!stats) return res.json({ ok: false, error: 'No stats returned' });
    const updated = schedulerModule.updateJob(req.params.id, {
      _youtube_stats: { ...stats, fetched_at: new Date().toISOString() },
      _youtube_stats_fetched: true,
    });
    res.json({ ok: true, stats, job: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── #24 Batch Topic Queue — create many jobs from a topic list ────────────────
app.post('/api/scheduler/batch-jobs', (req, res) => {
  const { topics, base_config } = req.body || {};
  if (!Array.isArray(topics) || !topics.length)
    return res.status(400).json({ ok: false, error: 'topics array required' });

  const created = [];
  const skipped = [];
  for (const rawTopic of topics) {
    const topic = (rawTopic || '').trim();
    if (!topic) { skipped.push(rawTopic); continue; }
    try {
      const job = schedulerModule.createJob({
        ...(base_config || {}),
        name:  base_config?.name ? `${base_config.name} — ${topic}` : topic,
        topic,
      });
      created.push({ id: job.id, topic });
    } catch (e) {
      skipped.push(topic);
    }
  }
  res.json({ ok: true, created: created.length, skipped: skipped.length, jobs: created });
});

// ── #26 Output delete ─────────────────────────────────────────────────────────
app.post('/api/scheduler/output-delete', (req, res) => {
  const { name } = req.body || {};
  if (!name || !/^[\w\-]+\.(mp4|jpg|jpeg)$/i.test(name))
    return res.status(400).json({ ok: false, error: 'invalid name' });
  const fp = path.join(__dirname, '../output', name);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    // Also delete associated thumbnail if deleting video
    if (/\.mp4$/i.test(name)) {
      const thumb = fp.replace(/\.mp4$/i, '_thumb.jpg');
      if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── #10 Scheduler config (concurrency) ───────────────────────────────────────
app.get('/api/scheduler/status', (req, res) => {
  res.json({ ok: true, ...schedulerModule.getSchedulerStatus() });
});

app.post('/api/scheduler/config', (req, res) => {
  const { max_concurrent } = req.body || {};
  if (max_concurrent !== undefined) {
    schedulerModule.setMaxConcurrent(max_concurrent);
  }
  res.json({ ok: true, ...schedulerModule.getSchedulerStatus() });
});

// ── #11 Thumbnail download ────────────────────────────────────────────────────
app.get('/api/scheduler/output/:filename', (req, res) => {
  // Handles both .mp4 and .jpg thumbnails
  const filename = path.basename(req.params.filename);
  if (!/^[\w\-]+\.(mp4|jpg|jpeg|png)$/i.test(filename))
    return res.status(400).end();
  const fp = path.join(__dirname, '../output', filename);
  if (!fs.existsSync(fp)) return res.status(404).end();
  const ext = path.extname(filename).toLowerCase();
  const ct  = ext === '.mp4' ? 'video/mp4' : 'image/jpeg';
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', ct);
  res.sendFile(fp);
});

// List completed output videos
app.get('/api/scheduler/outputs', (req, res) => {
  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) return res.json({ files: [] });
  const files = fs.readdirSync(outputDir)
    .filter(f => /^[\w\-]+\.(mp4|jpg|jpeg)$/i.test(f) && !/_raw\.mp4$/i.test(f))
    .map(f => {
      const fp   = path.join(outputDir, f);
      const stat = fs.statSync(fp);
      return { name: f, size: stat.size, mtime: stat.mtime.toISOString(), type: /\.mp4$/i.test(f) ? 'video' : 'image' };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json({ files });
});


// Footage sources config status
app.get('/api/config/footage-sources', (req, res) => {
  // YouTube uses yt-dlp (no API key needed) — check binary availability
  const ytDlpAvailable = (() => {
    try {
      require('child_process').execFileSync(
        process.platform === 'win32' ? 'where' : 'which',
        ['yt-dlp'],
        { timeout: 3000, stdio: 'pipe' }
      );
      return true;
    } catch (_) {
      // Also check common install paths
      const paths = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
      return paths.some(p => require('fs').existsSync(p));
    }
  })();

  res.json({
    pexels:  !!process.env.PEXELS_API_KEY,
    pixabay: !!process.env.PIXABAY_API_KEY,
    youtube: ytDlpAvailable,
  });
});

// ── Stock footage finder ──────────────────────────────────────────────────────
app.post('/api/find-footage', async (req, res) => {
  const {
    scenes,
    clips_per_scene = 2,
    orientation     = 'landscape',
    use_youtube     = false,
    yt_quality      = '720',
  } = req.body || {};

  if (!Array.isArray(scenes) || !scenes.length) {
    return res.status(400).json({ ok: false, error: 'scenes[] array required' });
  }

  const hasStock = !!(process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY);
  if (!hasStock && !use_youtube) {
    return res.status(500).json({ ok: false, error: 'No footage source configured. Add PEXELS_API_KEY / PIXABAY_API_KEY to .env, or enable YouTube.' });
  }

  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger = createSessionLogger(sessionId);

  try {
    const sources = [hasStock && 'Stock', use_youtube && 'YouTube'].filter(Boolean).join(' + ');
    logger.log(`🎥 Finding footage for ${scenes.length} scenes (${clips_per_scene} clip/scene, ${orientation}, ${sources})…`);
    const clips = await findFootageForScenes(
      scenes, process.env, logger,
      parseInt(clips_per_scene),
      orientation,
      !!use_youtube,
      yt_quality,
    );
    res.json({ ok: true, session_id: sessionId, clips });
  } catch (err) {
    logger.error(`❌ Footage finder: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    setTimeout(() => cleanupSession(sessionId), 60_000);
  }
});

// ── Caption templates list ────────────────────────────────────────────────────
app.get('/api/caption-templates', (req, res) => {
  const list = Object.entries(CAPTION_TEMPLATES).map(([id, t]) => ({
    id,
    label:   t.label,
    desc:    t.desc,
    preview: t.preview,
  }));
  res.json({ ok: true, templates: list });
});

// ── Burn captions (all-in-one: extract audio → Groq Whisper → styled ASS → FFmpeg) ──
app.post('/api/burn-captions', async (req, res) => {
  // Collect all Groq keys for rotation inside transcribeWithGroq
  const apiKeys = ['GROQ_API_KEY','GROQ_API_KEY_2','GROQ_API_KEY_3']
    .map(k => process.env[k]).filter(Boolean);
  if (!apiKeys.length) {
    return res.status(500).json({ ok: false, error: 'No GROQ_API_KEY configured in .env' });
  }

  const form      = formidable({ maxFileSize: 1024 * 1024 * 1024, keepExtensions: true }); // 1 GB
  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger    = createSessionLogger(sessionId);

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });

    const videoFile = Array.isArray(files.video) ? files.video[0] : files.video;
    if (!videoFile) return res.status(400).json({ ok: false, error: 'No video file provided' });

    const templateId = (Array.isArray(fields.template) ? fields.template[0] : fields.template) || 'bold_white';
    const ext        = path.extname(videoFile.originalFilename || 'video.mp4') || '.mp4';
    const inputPath  = path.join(os.tmpdir(), `caps_in_${sessionId}${ext}`);
    const outputPath = path.join(os.tmpdir(), `caps_out_${sessionId}.mp4`);

    fs.copyFileSync(videoFile.filepath, inputPath);
    logger.log(`🎬 Burn captions: template=${templateId}, input=${(fs.statSync(inputPath).size / 1048576).toFixed(1)} MB`);

    try {
      // Pass all keys — burnCaptions now rotates on 429
      await burnCaptions(inputPath, outputPath, templateId, apiKeys, logger);

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new Error('Caption burn produced an empty file');
      }

      // Stream the file instead of buffering it — avoids OOM on large videos
      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="captioned.mp4"');
      res.setHeader('Content-Length', stat.size);

      const stream = fs.createReadStream(outputPath);
      stream.on('error', e => { logger.error(`Stream error: ${e.message}`); res.destroy(); });
      stream.pipe(res).on('finish', () => {
        logger.log('✅ Response streamed');
        try { fs.unlinkSync(outputPath); } catch(_) {}
      });
    } catch (e) {
      logger.error(`❌ Burn captions failed: ${e.message}`);
      if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    } finally {
      try { fs.unlinkSync(inputPath); } catch(_) {}
      setTimeout(() => cleanupSession(sessionId), 60_000);
    }
  });
});

// Serve downloaded footage files (sanitised filename only)
app.get('/api/footage-file/:filename', (req, res) => {
  const { filename } = req.params;
  // Allow both video footage clips and image-derived clips
  if (!/^(footage|img_clip)_[a-z0-9_]+\.mp4$/i.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  // Check footage dir first, then image dir
  let filePath = path.join(FOOTAGE_DIR, filename);
  if (!fs.existsSync(filePath)) filePath = path.join(IMAGE_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.sendFile(filePath);
});


// ── Music search ──────────────────────────────────────────────────────────────
app.get('/api/search-music', async (req, res) => {
  const { q = '', mood = '', type = 'music' } = req.query;
  const jamendoId  = process.env.JAMENDO_CLIENT_ID;
  const freesoundKey = process.env.FREESOUND_API_KEY;

  if (type === 'sfx') {
    if (!freesoundKey) return res.status(400).json({ ok: false, error: 'FREESOUND_API_KEY not configured in .env — get a free key at freesound.org/apiv2/apply/' });
    try {
      const results = await searchFreesound(q || 'impact', freesoundKey, { limit: 10, maxDur: 20 });
      return res.json({ ok: true, results, source: 'freesound' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Background music via Jamendo
  if (!jamendoId) return res.status(400).json({ ok: false, error: 'JAMENDO_CLIENT_ID not configured in .env — get a free ID at devportal.jamendo.com' });
  try {
    const results = await searchJamendo(q, jamendoId, { limit: 10, mood });
    res.json({ ok: true, results, source: 'jamendo' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Download & cache a music/SFX track ───────────────────────────────────────
app.post('/api/download-track', async (req, res) => {
  const { url, filename } = req.body || {};
  if (!url || !filename) return res.status(400).json({ ok: false, error: 'url and filename required' });
  if (!/^(jamendo|freesound)_[a-z0-9._-]+\.(mp3|ogg|wav)$/i.test(filename)) {
    return res.status(400).json({ ok: false, error: 'Invalid filename' });
  }
  const logger = { log: m => console.log(m), error: m => console.error(m) };
  try {
    const localPath = await downloadTrack(url, filename, logger);
    res.json({ ok: true, localPath, serveUrl: `/api/music-file/${filename}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Serve a cached music file ─────────────────────────────────────────────────
app.get('/api/music-file/:filename', (req, res) => {
  const { filename } = req.params;
  if (!/^(jamendo|freesound)_[a-z0-9._-]+\.(mp3|ogg|wav)$/i.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(MUSIC_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.sendFile(filePath);
});

// ── Mix background music under a video ───────────────────────────────────────
app.post('/api/mix-music', async (req, res) => {
  const form      = formidable({ maxFileSize: 1024 * 1024 * 1024, keepExtensions: true });
  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger    = createSessionLogger(sessionId);

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });

    const videoFile = Array.isArray(files.video) ? files.video[0] : files.video;
    const musicFile = Array.isArray(files.music) ? files.music[0] : files.music;
    if (!videoFile || !musicFile) return res.status(400).json({ ok: false, error: 'video and music files required' });

    const volume     = parseFloat((Array.isArray(fields.volume) ? fields.volume[0] : fields.volume) || '0.18');
    const fadeIn     = parseFloat((Array.isArray(fields.fade_in) ? fields.fade_in[0] : fields.fade_in) || '2');
    const fadeOut    = parseFloat((Array.isArray(fields.fade_out) ? fields.fade_out[0] : fields.fade_out) || '3');
    const outputPath = path.join(os.tmpdir(), `music_mixed_${sessionId}.mp4`);
    const inputPath  = path.join(os.tmpdir(), `music_in_${sessionId}.mp4`);

    fs.copyFileSync(videoFile.filepath, inputPath);
    const musicPath = musicFile.filepath;

    try {
      await mixMusicUnderVideo({ videoPath: inputPath, musicPath, outputPath, musicVolume: volume, fadeIn, fadeOut, logger });
      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="with_music.mp4"');
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res).on('finish', () => { try { fs.unlinkSync(outputPath); } catch(_) {} });
    } catch (e) {
      logger.error(`❌ Music mix: ${e.message}`);
      if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
    } finally {
      try { fs.unlinkSync(inputPath); } catch(_) {}
      setTimeout(() => cleanupSession(sessionId), 30_000);
    }
  });
});


// ── OmniVoice TTS status + voices ────────────────────────────────────────────
const OMNIVOICE_VOICE_PRESETS = [
  { id: 'omni_narrator_warm',       name: 'Nova — Warm Narrator',        description: 'nova' },
  { id: 'omni_narrator_confident',  name: 'Cedar — Confident Narrator',  description: 'cedar' },
  { id: 'omni_narrator_calm',       name: 'Marin — Calm Narrator',       description: 'marin' },
  { id: 'omni_narrator_energetic',  name: 'Verse — Energetic Narrator',  description: 'verse' },
  { id: 'omni_narrator_deep',       name: 'Onyx — Deep Narrator',        description: 'onyx' },
  { id: 'omni_narrator_crisp',      name: 'Fable — Crisp Narrator',      description: 'fable' },
  { id: 'omni_narrator_young_m',    name: 'Ash — Young Male',            description: 'ash' },
  { id: 'omni_narrator_young_f',    name: 'Shimmer — Young Female',      description: 'shimmer' },
  { id: 'omni_podcast_host',        name: 'Echo — Podcast Host',         description: 'echo' },
  { id: 'omni_podcast_guest',       name: 'Alloy — Podcast Guest',       description: 'alloy' },
];

app.get('/api/omnivoice-status', async (req, res) => {
  const OMNIVOICE_URL = process.env.OMNIVOICE_URL || 'http://localhost:8881';
  try {
    const response = await fetch(`${OMNIVOICE_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      res.json({ ok: true, url: OMNIVOICE_URL });
    } else {
      res.json({ ok: false, url: OMNIVOICE_URL, error: `HTTP ${response.status}` });
    }
  } catch (err) {
    res.json({ ok: false, url: OMNIVOICE_URL, error: err.message });
  }
});

app.get('/api/omnivoice-voices', (req, res) => {
  res.json({ ok: true, voices: OMNIVOICE_VOICE_PRESETS });
});

// ── YouTube downloader endpoints ──────────────────────────────────────────────

// GET info without downloading
app.post('/api/youtube-info', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url required' });
  try {
    const info = await getYouTubeInfo(url.trim(), console);
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST — download a YouTube URL, return a serveUrl for the video combiner
app.post('/api/download-youtube', async (req, res) => {
  const { url, quality = '1080' } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url required' });

  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger = createSessionLogger(sessionId);
  try {
    logger.log(`📥 YouTube download request: ${url} @ ${quality}p`);
    const { filename } = await downloadYouTube(url.trim(), { quality, logger });
    const serveUrl = `/api/youtube-file/${encodeURIComponent(filename)}`;
    logger.log(`✅ Ready: ${serveUrl}`);
    res.json({ ok: true, filename, serveUrl });
  } catch (e) {
    logger.log(`❌ Download failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    setTimeout(() => cleanupSession(sessionId), 5000);
  }
});

// ── YouTube auth endpoints ────────────────────────────────────────────────────

// Cookie status check
app.get('/api/youtube-auth/status', (req, res) => {
  res.json({ ok: true, ...cookieStatus() });
});

// Step 1: Open the user's real browser (Vivaldi/Firefox) at youtube.com
// Google trusts real browsers — Selenium's fresh profile gets blocked.
app.post('/api/youtube-auth/open-browser', (req, res) => {
  const { browser = 'auto' } = req.body || {};
  try {
    const result = openRealBrowser(browser);
    res.json({ ok: true, browser: result.browser });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Step 2 (alternative): extract from already-logged-in browser
app.post('/api/youtube-auth/extract', async (req, res) => {
  const { browser = 'vivaldi' } = req.body || {};
  const logger = { log: m => console.log('[yt-auth]', m) };
  const result = await extractFromBrowser(browser, logger);
  res.json(result.ok ? { ok: true, status: cookieStatus() } : result);
});

// Clear saved cookies
app.post('/api/youtube-auth/clear', (req, res) => {
  clearCookies();
  res.json({ ok: true });
});

// ── #14 YouTube Upload OAuth setup endpoints ──────────────────────────────────
app.get('/api/youtube-upload/auth-url', (req, res) => {
  try {
    const { getConsentUrl } = require('./youtube-uploader');
    const url = getConsentUrl(process.env);
    res.json({ ok: true, url });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/youtube-upload/exchange-code', async (req, res) => {
  try {
    const { exchangeCodeForTokens } = require('./youtube-uploader');
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, error: 'code required' });
    const tokens = await exchangeCodeForTokens(code, process.env);
    // Tell user to add the refresh_token to their .env
    res.json({ ok: true, refresh_token: tokens.refresh_token, message: 'Add YOUTUBE_REFRESH_TOKEN to your .env file' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/youtube-upload/status', (req, res) => {
  const configured = !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN);
  res.json({ ok: true, configured });
});

// ── YouTube search endpoint ───────────────────────────────────────────────────
app.get('/api/youtube-search', async (req, res) => {
  const { q = '', limit = '12', filter = 'any' } = req.query;
  if (!q.trim()) return res.status(400).json({ ok: false, error: 'q is required' });

  const logger = { log: m => console.log('[yt-search]', m) };
  try {
    const results = await searchYouTube(q.trim(), {
      limit:  Math.min(24, Math.max(1, parseInt(limit) || 12)),
      filter,
      logger,
    });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve cached YouTube files
app.get('/api/youtube-file/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
  const filePath = require('path').join(YT_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Content-Length', fs.statSync(filePath).size);
  fs.createReadStream(filePath).pipe(res);
});

// ── TTS text preprocessor ─────────────────────────────────────────────────────
// Cleans narration text so OmniVoice produces natural-sounding speech instead of
// robotic literal readings of symbols, markdown, numbers, and punctuation.
// Delegate to shared tts-utils module
function preprocessTTS(raw) { return _preprocessTTS(raw); }

function _preprocessTTS_UNUSED(raw) {
  let t = raw;

  // 1. Strip markdown formatting
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');          // **bold**
  t = t.replace(/\*(.+?)\*/g, '$1');               // *italic*
  t = t.replace(/__(.+?)__/g, '$1');               // __underline__
  t = t.replace(/_(.+?)_/g, '$1');                 // _italic_
  t = t.replace(/#{1,6}\s*/g, '');                 // ## headings
  t = t.replace(/`{1,3}[^`]*`{1,3}/g, '');        // `code`
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');  // [link](url)
  t = t.replace(/https?:\/\/\S+/g, '');           // bare URLs

  // 2. Punctuation that sounds robotic when read literally
  t = t.replace(/—/g, ', ');          // em-dash → comma pause
  t = t.replace(/–/g, ', ');          // en-dash
  t = t.replace(/…/g, '... ');        // ellipsis → spaced dots
  t = t.replace(/’/g, "'");      // curly apostrophe
  t = t.replace(/[“”]/g, '"'); // curly quotes
  t = t.replace(/·|•|●/g, '. '); // bullet symbols → sentence break

  // 3. Symbols → spoken words
  t = t.replace(/(\d+)\s*%/g, '$1 percent');
  t = t.replace(/\$(\d[\d,]*)/g, '$1 dollars');
  t = t.replace(/£(\d[\d,]*)/g, '$1 pounds');
  t = t.replace(/€(\d[\d,]*)/g, '$1 euros');
  t = t.replace(/&/g, ' and ');
  t = t.replace(/\+/g, ' plus ');
  t = t.replace(/#(\w+)/g, '$1');     // #hashtag → hashtag (drop the #)
  t = t.replace(/@(\w+)/g, '$1');     // @mention → mention

  // 4. Numbered / bulleted list items → just the text
  //    "1. First thing"  →  "First thing."
  t = t.replace(/^\s*\d+\.\s+/gm, '');
  t = t.replace(/^\s*[-•]\s+/gm, '');

  // 5. Abbreviations → spoken forms
  t = t.replace(/\betc\.\s*/gi, 'et cetera. ');
  t = t.replace(/\be\.g\.\s*/gi, 'for example, ');
  t = t.replace(/\bi\.e\.\s*/gi, 'that is, ');
  t = t.replace(/\bvs\.\s*/gi, 'versus ');
  t = t.replace(/\bDr\.\s+/g, 'Doctor ');
  t = t.replace(/\bMr\.\s+/g, 'Mister ');
  t = t.replace(/\bMrs\.\s+/g, 'Missus ');
  t = t.replace(/\bSt\.\s+/g, 'Saint ');

  // 6. Ordinal numbers → spoken  (1st → first, 2nd → second, up to 20th)
  const ordinals = { '1st':'first','2nd':'second','3rd':'third','4th':'fourth',
    '5th':'fifth','6th':'sixth','7th':'seventh','8th':'eighth','9th':'ninth',
    '10th':'tenth','11th':'eleventh','12th':'twelfth','13th':'thirteenth',
    '14th':'fourteenth','15th':'fifteenth','16th':'sixteenth','17th':'seventeenth',
    '18th':'eighteenth','19th':'nineteenth','20th':'twentieth' };
  t = t.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, (m, n, s) => ordinals[n+s.toLowerCase()] || m);

  // 7. Numbers 1-20 in isolation → words (avoids "two thousand twenty-three" style issues)
  const nums = ['zero','one','two','three','four','five','six','seven','eight','nine',
                 'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen',
                 'seventeen','eighteen','nineteen','twenty'];
  t = t.replace(/\b(\d{1,2})\b/g, (m, n) => {
    const i = parseInt(n, 10);
    return (i <= 20 && nums[i]) ? nums[i] : m;
  });

  // 8. Clean up whitespace and stray punctuation from substitutions
  t = t.replace(/[ \t]{2,}/g, ' ');          // multiple spaces → one
  t = t.replace(/\n{3,}/g, '\n\n');           // max double newline
  t = t.replace(/([.!?])\s*([.!?])+/g, '$1'); // duplicate terminal punctuation
  t = t.replace(/,\s*,/g, ',');               // double commas
  t = t.replace(/\(\s*\)/g, '');              // empty parens

  return t.trim();
}

// Delegate to shared tts-utils module (returns array of {text, paragraphEnd} objects)
function chunkTTS(text, maxChars = 300) { return _chunkTTS(text, maxChars); }

function _chunkTTS_UNUSED(text, maxChars = 500) {
  // First split on blank lines (paragraph breaks)
  const paras = text.split(/\n{2,}/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const chunks = [];

  for (const para of paras) {
    if (para.length <= maxChars) {
      chunks.push(para);
      continue;
    }
    // Split long paragraph at sentence boundaries
    const sentences = para.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [para];
    let current = '';
    for (const s of sentences) {
      if ((current + ' ' + s).trim().length > maxChars && current.length > 0) {
        chunks.push(current.trim());
        current = s;
      } else {
        current = (current + ' ' + s).trim();
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// ── OmniVoice voice presets — mapped to named character voices ────────────────
const VOICE_PRESETS = {
  'narrator_warm':      'nova',    // female, warm american
  'narrator_confident': 'cedar',   // male, steady american
  'narrator_calm':      'marin',   // female, soft canadian
  'narrator_energetic': 'verse',   // male, upbeat british
  'narrator_deep':      'onyx',    // male, deep british
  'narrator_crisp':     'fable',   // female, crisp british
  'narrator_young_m':   'ash',     // male, young american
  'narrator_young_f':   'shimmer', // female, bright american
  'podcast_host':       'echo',    // male, conversational canadian
  'podcast_guest':      'alloy',   // female, clear american
};

function resolveVoice(input) {
  return VOICE_PRESETS[input] || input || 'nova';
}

// List OmniVoice voice presets
app.get('/api/voice-presets', (req, res) => {
  const presets = Object.entries(VOICE_PRESETS).map(([id, description]) => ({ id, description }));
  res.json({ ok: true, presets });
});

// OmniVoice TTS proxy — cleans + chunks text then stitches audio back to client
app.post('/api/tts', async (req, res) => {
  const OMNIVOICE_URL = process.env.OMNIVOICE_URL || 'http://localhost:8881';
  const { text, voice = 'narrator_warm', speed = 1.0, format = 'wav' } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 50000) {
    return res.status(400).json({ error: 'text too long (max 50000 chars)' });
  }

  const cleaned      = preprocessTTS(text.trim());
  const chunks       = chunkTTS(cleaned, 250);
  const description  = resolveVoice(voice);
  const effectiveSpeed = Math.min(1.05, Math.max(1.0, speed));

  try {
    const wavChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const { text: chunkText, paragraphEnd } = chunks[i];
      if (!chunkText.trim()) continue;
      const r = await fetch(`${OMNIVOICE_URL}/v1/audio/speech`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: 'omnivoice', input: chunkText, voice: description, speed: effectiveSpeed, response_format: 'wav', seed: 42 }),
        signal:  AbortSignal.timeout(180_000),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        return res.status(502).json({ error: `OmniVoice chunk ${i + 1} failed`, details: errText });
      }
      wavChunks.push({ buf: Buffer.from(await r.arrayBuffer()), paragraphEnd });
    }

    if (!wavChunks.length) return res.status(500).json({ error: 'No audio generated' });

    const combined = format === 'wav'
      ? stitchWavBuffers(wavChunks)
      : Buffer.concat(wavChunks.map(c => c.buf));

    res.set('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/mpeg');
    res.set('Content-Disposition', `attachment; filename="tts.${format}"`);
    res.set('Content-Length', combined.length);
    res.send(combined);
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'OmniVoice TTS timed out' });
    res.status(502).json({ error: 'OmniVoice unreachable', details: err.message });
  }
});

// Serve index.html as default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOTE WORKER API
// Workers (e.g. T440p) poll these endpoints to claim jobs, stream logs back,
// and report completion. Authentication is via a shared WORKER_SECRET env var.
// ─────────────────────────────────────────────────────────────────────────────
const WORKER_SECRET   = process.env.WORKER_SECRET || 'videocombine-worker';
const _workerLogSubs  = new Map(); // jobId → Set<res>
// _workers and WORKER_TIMEOUT live in server-state.js so scheduler.js can read them without circular deps
const { _workers, WORKER_TIMEOUT } = require('./server-state');

// Periodically clean up stale worker entries and release their claimed jobs
setInterval(() => {
  const now = Date.now();
  for (const [id, w] of _workers) {
    if (now - w.lastSeen > WORKER_TIMEOUT * 2) {
      // Release any jobs this worker had claimed so they can be picked up again
      for (const jobId of w.running) { // w.running is always plain strings
        const job = schedulerModule.getJob(jobId);
        if (job && job._claimed_by === id) {
          console.log(`[Worker] Releasing stale job "${job.name}" from dead worker ${id}`);
          schedulerModule.upsertJob({ ...job, status: 'idle', _claimed_by: null });
        }
      }
      _workers.delete(id);
      console.log(`[Worker] Removed stale worker: ${id}`);
    }
  }
}, 30_000);

function workerAuth(req, res, next) {
  const secret = req.headers['x-worker-secret'] || req.query.secret;
  if (secret !== WORKER_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// Worker registers / heartbeats
app.post('/api/workers/register', workerAuth, (req, res) => {
  const { worker_id, host, capacity = 2, running = [], stats = {} } = req.body;
  if (!worker_id) return res.status(400).json({ ok: false, error: 'worker_id required' });

  const existing = _workers.get(worker_id) || {};

  // Reconcile: only keep job IDs that actually exist and are still running
  // w.running is ALWAYS an array of plain job ID strings — never objects
  const reportedIds  = (Array.isArray(running) ? running : []).map(r => (typeof r === 'object' ? r.id : r)).filter(Boolean);
  const validRunning = reportedIds.filter(id => {
    const job = schedulerModule.getJob(id);
    return job && job.status === 'running';
  });

  // Preserve any IDs the server already knows are running (in case of race)
  const serverRunning = (existing.running || []);
  const mergedRunning = [...new Set([...validRunning, ...serverRunning])].filter(id => {
    const job = schedulerModule.getJob(id);
    return job && job.status === 'running';
  });

  _workers.set(worker_id, {
    id:          worker_id,
    host:        host || req.ip,
    capacity:    parseInt(capacity) || 2,
    running:     mergedRunning,  // always plain string IDs
    lastSeen:    Date.now(),
    connectedAt: existing.connectedAt || Date.now(),
    stats:       { ...existing.stats, ...stats },
  });
  res.json({ ok: true, server_time: Date.now() });
});

// UI: list workers
app.get('/api/workers', (req, res) => {
  const now  = Date.now();
  const jobs = schedulerModule.loadJobs();
  const list = [..._workers.values()].map(w => {
    // w.running is always plain string IDs — enrich with names here for UI only
    const runningJobs = (w.running || []).map(id => {
      const j = jobs.find(x => x.id === id);
      return { id, name: j?.name || id, status: j?.status || 'unknown' };
    });
    return {
      id:          w.id,
      host:        w.host,
      capacity:    w.capacity,
      connectedAt: w.connectedAt,
      lastSeen:    w.lastSeen,
      stats:       w.stats,
      running:     runningJobs,   // enriched objects for UI
      online:      (now - w.lastSeen) < WORKER_TIMEOUT,
      lastSeenAgo: now - w.lastSeen,
    };
  });
  res.json({ ok: true, workers: list });
});

// Worker polls for the next available job
app.get('/api/workers/poll', workerAuth, (req, res) => {
  const { worker_id, capacity: cap } = req.query;
  if (!worker_id) return res.status(400).json({ ok: false, error: 'worker_id required' });

  const w = _workers.get(worker_id);
  if (w) { w.lastSeen = Date.now(); if (cap) w.capacity = parseInt(cap) || w.capacity; }

  const runningCount = w ? w.running.length : 0;
  const maxCap       = w ? w.capacity : 2;
  if (runningCount >= maxCap) return res.json({ ok: true, job: null, reason: 'at_capacity' });

  // Build set of job IDs already claimed by any worker (avoid double-claiming)
  // w.running is always plain strings on the server side
  const claimedIds = new Set([..._workers.values()].flatMap(x => x.running || []));

  const jobs = schedulerModule.loadJobs();

  // Priority 1: jobs explicitly assigned to this worker
  // Priority 2: unassigned jobs (any worker can pick up)
  const next =
    jobs.find(j => j.enabled && j.status === 'idle' && j.assigned_worker === worker_id && !claimedIds.has(j.id)) ||
    jobs.find(j => j.enabled && j.status === 'idle' && !j.assigned_worker               && !claimedIds.has(j.id));

  if (!next) return res.json({ ok: true, job: null });

  // Atomically claim: mark running + record who claimed it
  schedulerModule.upsertJob({ ...next, status: 'running', _claimed_by: worker_id, _claim_time: Date.now() });
  if (w && !w.running.includes(next.id)) w.running.push(next.id); // always push plain string ID

  console.log(`[Worker] "${next.name}" → ${worker_id}`);
  res.json({ ok: true, job: next });
});

// Worker streams a log line (batched: accepts array or single line)
app.post('/api/workers/log', workerAuth, (req, res) => {
  const { worker_id, job_id, line, lines } = req.body;
  if (!job_id) return res.status(400).json({ ok: false });

  const entries = lines || (line ? [line] : []);
  const subs    = _workerLogSubs.get(job_id);
  if (subs && subs.size > 0) {
    for (const entry of entries) {
      const payload = JSON.stringify({ log: entry, worker_id });
      for (const r of subs) {
        try { r.write(`data: ${payload}\n\n`); } catch (_) {}
      }
    }
  }
  res.json({ ok: true });
});

// Worker reports job completion
app.post('/api/workers/complete', workerAuth, async (req, res) => {
  const { worker_id, job_id, status, output, error: errMsg, stats = {} } = req.body;
  if (!job_id) return res.status(400).json({ ok: false });

  const job = schedulerModule.getJob(job_id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

  // Remove from worker's running list (always plain strings)
  const w = _workers.get(worker_id);
  if (w) {
    w.running = w.running.filter(r => r !== job_id);
    // Accumulate worker stats
    if (status === 'completed') w.stats = { ...w.stats, jobs_done: (w.stats?.jobs_done || 0) + 1 };
    if (status === 'failed')    w.stats = { ...w.stats, jobs_failed: (w.stats?.jobs_failed || 0) + 1 };
  }

  const localOutput = output || {};

  // Compute next run time (same logic as local scheduler)
  const nextRun = status === 'completed'
    ? schedulerModule.computeNextRun(job.schedule)
    : job.next_run_ms;

  const retryCount = status === 'failed' ? (job._retry_count || 0) + 1 : 0;
  const MAX_RETRIES = 3;
  const willRetry   = status === 'failed' && retryCount <= MAX_RETRIES;

  const updated = {
    ...job,
    status:         status === 'completed' ? 'idle' : (willRetry ? 'idle' : 'error'),
    _last_output:   localOutput,
    _last_run_at:   Date.now(),
    _claimed_by:    null,
    _claim_time:    null,
    _retry_count:   willRetry ? retryCount : 0,
    error_message:  willRetry ? null : (errMsg || null),
    next_run_ms:    willRetry ? Date.now() + 2 * 60_000 : nextRun,
  };
  schedulerModule.upsertJob(updated);

  if (willRetry) {
    console.log(`[Worker] "${job.name}" failed — retry ${retryCount}/${MAX_RETRIES} in 2 min`);
  }

  // Notify SSE subscribers
  const subs = _workerLogSubs.get(job_id);
  if (subs) {
    const payload = JSON.stringify({ done: true, status, output: localOutput, error: errMsg });
    for (const r of subs) {
      try { r.write(`data: ${payload}\n\n`); r.end(); } catch (_) {}
    }
    _workerLogSubs.delete(job_id);
  }

  console.log(`[Worker] "${job.name}" ${status} by ${worker_id}`);
  res.json({ ok: true, retry: willRetry });
});

// SSE: browser subscribes to live logs for a worker-run job
app.get('/api/workers/jobs/:id/logs', (req, res) => {
  const jobId = req.params.id;
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  // Send a keep-alive comment every 15 s so the connection doesn't time out
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15_000);
  if (!_workerLogSubs.has(jobId)) _workerLogSubs.set(jobId, new Set());
  _workerLogSubs.get(jobId).add(res);
  req.on('close', () => {
    clearInterval(ping);
    _workerLogSubs.get(jobId)?.delete(res);
  });
});

// Worker pushes finished video to main server (no inbound firewall needed on worker)
app.post('/api/workers/upload', workerAuth, (req, res) => {
  const jobId    = req.headers['x-job-id'];
  const workerId = req.headers['x-worker-id'] || 'unknown';
  const form     = formidable({ uploadDir: OUTPUT_DIR, keepExtensions: true, maxFileSize: 4 * 1024 * 1024 * 1024 });
  form.parse(req, (err, fields, files) => {
    if (err) { console.error('[Worker upload]', err.message); return res.status(500).json({ ok: false, error: err.message }); }
    const f = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!f) return res.status(400).json({ ok: false, error: 'No file received' });
    const orig = f.originalFilename || f.newFilename;
    const dest = path.join(OUTPUT_DIR, path.basename(orig)); // basename prevents traversal
    try { fs.renameSync(f.filepath, dest); } catch (e) {
      // rename fails across drives on Windows — fall back to copy+delete
      fs.copyFileSync(f.filepath, dest);
      fs.unlinkSync(f.filepath);
    }
    const url = `/api/scheduler/output/${encodeURIComponent(path.basename(orig))}`;
    console.log(`[Worker] Upload: ${path.basename(orig)} from ${workerId} (job ${jobId})`);
    res.json({ ok: true, url, path: dest });
  });
});

// Assign / unassign a job to a specific worker
app.post('/api/workers/assign', (req, res) => {
  const { job_id, worker_id } = req.body;
  const job = schedulerModule.getJob(job_id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  schedulerModule.upsertJob({ ...job, assigned_worker: worker_id || null });
  console.log(`[Worker] Job "${job.name}" assigned to ${worker_id || 'any'}`);
  res.json({ ok: true });
});

// Kick a specific worker job immediately (force-claim)
app.post('/api/workers/kick', (req, res) => {
  const { job_id, worker_id } = req.body;
  const job = schedulerModule.getJob(job_id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  if (job.status === 'running') return res.status(409).json({ ok: false, error: 'Already running' });
  schedulerModule.upsertJob({ ...job, assigned_worker: worker_id || null, status: 'idle' });
  res.json({ ok: true });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: err.message 
  });
});

// Start server
// ── Resource Usage Monitoring ───────────────────────────────────────────────────
app.get('/api/system/resources', (req, res) => {
  try {
    const rm = require('./resource-manager');
    const systemInfo = rm.getSystemInfo();
    const settings = rm.getSettings();
    const schedulerStatus = schedulerModule.getSchedulerStatus();
    
    res.json({
      ok: true,
      system: systemInfo,
      settings: settings,
      scheduler: schedulerStatus,
      canScheduleJob: rm.canScheduleJob(),
      recommendedConcurrency: rm.getRecommendedConcurrency()
    });
  } catch (e) {
    res.json({
      ok: false,
      error: e.message,
      system: {
        cpuCount: os.cpus().length,
        totalMemGB: (os.totalmem() / 1024 ** 3).toFixed(1),
        freeMemGB: (os.freemem() / 1024 ** 3).toFixed(1),
        memUsagePercent: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1),
      }
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n🎥 Video Combiner API running at http://localhost:${PORT}`);
  console.log(`📁 Open your browser to: http://localhost:${PORT}`);
  console.log(`🎬 API endpoint: POST http://localhost:${PORT}/api/video-combiner`);
  console.log(`💚 Health check: GET http://localhost:${PORT}/api/health`);
  console.log(`📊 Resource monitor: GET http://localhost:${PORT}/api/system/resources\n`);
  // Start the production scheduler
  schedulerModule.startScheduler(PORT);
});

// Extend socket timeout for long-running caption burn (Whisper + FFmpeg can take minutes)
server.setTimeout(20 * 60 * 1000); // 20 minutes
