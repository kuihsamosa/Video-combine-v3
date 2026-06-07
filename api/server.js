// Express Server for Video Combiner
// Serves a static browser UI + provides local API endpoints that run FFmpeg.

// Load .env if present (GROQ_API_KEY, PORT, KOKORO_URL, etc.)
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
  const { niche, platform = 'YouTube', goal, count = 8, tone, avoid, model } = req.body || {};
  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger = createSessionLogger(sessionId);
  try {
    const ideas = await brainstormIdeas(
      { niche, platform, goal, count, tone, avoid, model, env: process.env },
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

// Download a completed run's video
app.get('/api/scheduler/output/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/^sched_final_[a-f0-9]+\.mp4$/i.test(filename))
    return res.status(400).end();
  const fp = path.join(__dirname, '../output', filename);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(fp);
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
  if (!/^footage_[a-z0-9_]+\.mp4$/i.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(FOOTAGE_DIR, filename);
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

// Kokoro TTS status check
app.get('/api/kokoro-status', async (req, res) => {
  const KOKORO_URL = process.env.KOKORO_URL || 'http://localhost:8880';
  try {
    const response = await fetch(`${KOKORO_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      res.json({ ok: true, url: KOKORO_URL });
    } else {
      res.json({ ok: false, url: KOKORO_URL, error: `HTTP ${response.status}` });
    }
  } catch (err) {
    res.json({ ok: false, url: KOKORO_URL, error: err.message });
  }
});

// Kokoro voices list
app.get('/api/kokoro-voices', async (req, res) => {
  const KOKORO_URL = process.env.KOKORO_URL || 'http://localhost:8880';
  const FALLBACK_VOICES = [
    { id: 'af_heart', name: 'Heart (US Female)', lang: 'en-us' },
    { id: 'af_bella', name: 'Bella (US Female)', lang: 'en-us' },
    { id: 'af_nicole', name: 'Nicole (US Female)', lang: 'en-us' },
    { id: 'af_sky', name: 'Sky (US Female)', lang: 'en-us' },
    { id: 'am_adam', name: 'Adam (US Male)', lang: 'en-us' },
    { id: 'am_michael', name: 'Michael (US Male)', lang: 'en-us' },
    { id: 'bf_emma', name: 'Emma (UK Female)', lang: 'en-gb' },
    { id: 'bf_isabella', name: 'Isabella (UK Female)', lang: 'en-gb' },
    { id: 'bm_george', name: 'George (UK Male)', lang: 'en-gb' },
    { id: 'bm_lewis', name: 'Lewis (UK Male)', lang: 'en-gb' },
  ];
  try {
    const response = await fetch(`${KOKORO_URL}/v1/voices`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const data = await response.json();
      res.json({ ok: true, voices: data.voices || data || FALLBACK_VOICES });
    } else {
      res.json({ ok: true, voices: FALLBACK_VOICES, source: 'fallback' });
    }
  } catch (err) {
    res.json({ ok: true, voices: FALLBACK_VOICES, source: 'fallback' });
  }
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
// Cleans narration text so Kokoro produces natural-sounding speech instead of
// robotic literal readings of symbols, markdown, numbers, and punctuation.
function preprocessTTS(raw) {
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
  t = t.replace(/…/g, '... ');        // ellipsis → spaced dots Kokoro handles
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

// Splits cleaned text into natural paragraph/sentence chunks so Kokoro doesn't
// receive one giant wall of text (which degrades prosody on long scripts).
// Returns an array of strings, each ≤ maxChars.
function chunkTTS(text, maxChars = 500) {
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

// ── Voice presets — map a friendly preset name to a Kokoro voice blend string ──
// Kokoro supports weighted blends: "voice1(w1)+voice2(w2)" or "v1+v2" (equal weight).
// Weights are arbitrary positive floats (Kokoro normalises them internally).
const VOICE_PRESETS = {
  // Narration styles
  'narrator_warm':      'af_heart(0.65)+af_jessica(0.35)',    // warm, intimate
  'narrator_confident': 'am_adam(0.55)+am_michael(0.45)',     // authoritative male
  'narrator_calm':      'af_bella(0.6)+af_heart(0.4)',        // smooth, soothing female
  'narrator_energetic': 'am_fenrir(0.6)+am_puck(0.4)',        // punchy, dynamic male
  'narrator_deep':      'bm_george(0.7)+am_adam(0.3)',        // deep, cinematic
  'narrator_crisp':     'bf_emma(0.55)+af_jessica(0.45)',     // clear, British-lite
  // Base voices (pass-through, no blend)
  'af_heart': 'af_heart', 'af_bella': 'af_bella', 'af_jessica': 'af_jessica',
  'af_nicole': 'af_nicole', 'af_sky': 'af_sky', 'af_river': 'af_river',
  'am_adam': 'am_adam', 'am_michael': 'am_michael', 'am_echo': 'am_echo',
  'am_liam': 'am_liam', 'am_fenrir': 'am_fenrir', 'am_puck': 'am_puck',
  'bm_george': 'bm_george', 'bm_daniel': 'bm_daniel', 'bm_lewis': 'bm_lewis',
  'bf_emma': 'bf_emma', 'bf_alice': 'bf_alice',
};

function resolveVoice(input) {
  // If it's a preset name, expand it. If it's already a blend (contains + or ()),
  // pass through as-is. Otherwise use as a direct voice name.
  return VOICE_PRESETS[input] || input || 'af_heart';
}

// List voice presets
app.get('/api/voice-presets', (req, res) => {
  const presets = [
    { id: 'narrator_warm',      label: 'Narrator — Warm & Intimate',    blend: VOICE_PRESETS['narrator_warm'] },
    { id: 'narrator_confident', label: 'Narrator — Confident Male',      blend: VOICE_PRESETS['narrator_confident'] },
    { id: 'narrator_calm',      label: 'Narrator — Calm & Smooth',       blend: VOICE_PRESETS['narrator_calm'] },
    { id: 'narrator_energetic', label: 'Narrator — Energetic & Punchy',  blend: VOICE_PRESETS['narrator_energetic'] },
    { id: 'narrator_deep',      label: 'Narrator — Deep & Cinematic',    blend: VOICE_PRESETS['narrator_deep'] },
    { id: 'narrator_crisp',     label: 'Narrator — Crisp & Clear',       blend: VOICE_PRESETS['narrator_crisp'] },
    // Single voices
    { id: 'af_heart',    label: 'Heart (US Female)'    },
    { id: 'af_bella',    label: 'Bella (US Female)'    },
    { id: 'af_jessica',  label: 'Jessica (US Female)'  },
    { id: 'af_nicole',   label: 'Nicole (US Female)'   },
    { id: 'af_sky',      label: 'Sky (US Female)'      },
    { id: 'af_river',    label: 'River (US Female)'    },
    { id: 'am_adam',     label: 'Adam (US Male)'       },
    { id: 'am_michael',  label: 'Michael (US Male)'    },
    { id: 'am_echo',     label: 'Echo (US Male)'       },
    { id: 'am_liam',     label: 'Liam (US Male)'       },
    { id: 'am_fenrir',   label: 'Fenrir (US Male)'     },
    { id: 'am_puck',     label: 'Puck (US Male)'       },
    { id: 'bm_george',   label: 'George (UK Male)'     },
    { id: 'bm_daniel',   label: 'Daniel (UK Male)'     },
    { id: 'bm_lewis',    label: 'Lewis (UK Male)'      },
    { id: 'bf_emma',     label: 'Emma (UK Female)'     },
    { id: 'bf_alice',    label: 'Alice (UK Female)'    },
  ];
  res.json({ ok: true, presets });
});

// Kokoro TTS proxy — cleans + chunks text then stitches audio, streams back to client
app.post('/api/tts', async (req, res) => {
  const KOKORO_URL = process.env.KOKORO_URL || 'http://localhost:8880';
  const { text, voice = 'af_heart', speed = 1.0, format = 'wav' } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 50000) {
    return res.status(400).json({ error: 'text too long (max 50000 chars)' });
  }

  const cleaned     = preprocessTTS(text.trim());
  const chunks      = chunkTTS(cleaned, 480);
  const resolvedVoice = resolveVoice(voice);
  // Slightly slower default speed improves naturalness (0.92 if caller sends 1.0)
  const effectiveSpeed = speed === 1.0 ? 0.92 : speed;

  // Kokoro normalization options — let Kokoro handle what it can natively
  const normOpts = {
    normalize: true,
    unit_normalization: true,
    url_normalization: true,
    email_normalization: true,
    optional_pluralization_normalization: true,
    phone_normalization: true,
    replace_remaining_symbols: true,
  };

  try {
    // If single chunk, simple passthrough (no concat needed)
    if (chunks.length === 1) {
      const kokoroRes = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro', input: chunks[0],
          voice: resolvedVoice, speed: effectiveSpeed,
          response_format: format, stream: false,
          normalization_options: normOpts,
        }),
        signal: AbortSignal.timeout(180000)
      });
      if (!kokoroRes.ok) {
        const errText = await kokoroRes.text().catch(() => '');
        return res.status(502).json({ error: 'Kokoro TTS failed', details: errText });
      }
      const contentType = kokoroRes.headers.get('content-type') || `audio/${format}`;
      res.set('Content-Type', contentType);
      res.set('Content-Disposition', `attachment; filename="tts.${format}"`);
      const buf = await kokoroRes.arrayBuffer();
      return res.send(Buffer.from(buf));
    }

    // Multiple chunks — call Kokoro per chunk, concatenate raw PCM/WAV buffers
    const buffers = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk.trim()) continue;
      const kokoroRes = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro', input: chunk,
          voice: resolvedVoice, speed: effectiveSpeed,
          response_format: format, stream: false,
          normalization_options: normOpts,
        }),
        signal: AbortSignal.timeout(180000)
      });
      if (!kokoroRes.ok) {
        const errText = await kokoroRes.text().catch(() => '');
        return res.status(502).json({ error: `Kokoro chunk ${i + 1} failed`, details: errText });
      }
      buffers.push(Buffer.from(await kokoroRes.arrayBuffer()));
    }

    if (buffers.length === 0) {
      return res.status(500).json({ error: 'No audio generated' });
    }

    // Stitch chunks together.
    // WAV: find the 'data' chunk offset in each buffer (don't hardcode 44 —
    // Kokoro sometimes outputs extended headers with LIST/INFO metadata).
    // MP3: raw concatenation is valid for same-bitrate streams.
    let combined;
    if (format === 'wav' && buffers.length > 1) {
      // Locate the 'data' sub-chunk in a WAV buffer by scanning for the marker.
      function findDataOffset(buf) {
        // WAV always starts RIFF....WAVEfmt  ...data....
        // Scan from byte 12 (after RIFF header) for the 'data' marker.
        for (let i = 12; i < buf.length - 8; i++) {
          if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61) {
            return i + 8; // skip 'data' (4) + chunk size (4)
          }
        }
        return 44; // fallback
      }

      // Keep the full first buffer (header + PCM data), strip headers from the rest
      const pcmParts = buffers.map((b, i) => i === 0 ? b : b.slice(findDataOffset(b)));
      combined = Buffer.concat(pcmParts);

      // Find where the data chunk starts in the combined buffer to patch sizes
      const dataOffset = findDataOffset(buffers[0]);
      const totalPcmBytes = combined.length - dataOffset;

      // Patch RIFF chunk size at offset 4 and data chunk size at (dataOffset - 4)
      combined.writeUInt32LE(combined.length - 8, 4);           // RIFF total size
      combined.writeUInt32LE(totalPcmBytes, dataOffset - 4);    // data chunk size
    } else {
      combined = Buffer.concat(buffers);
    }

    res.set('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/mpeg');
    res.set('Content-Disposition', `attachment; filename="tts.${format}"`);
    res.set('Content-Length', combined.length);
    res.send(combined);

  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Kokoro TTS timed out' });
    }
    res.status(502).json({ error: 'Kokoro unreachable', details: err.message });
  }
});

// Phonemize proxy — calls Kokoro /dev/phonemize and returns {phonemes, tokens}
app.post('/api/phonemize', async (req, res) => {
  const KOKORO_URL = process.env.KOKORO_URL || 'http://localhost:8880';
  const { text, language = 'a' } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }
  try {
    const r = await fetch(`${KOKORO_URL}/dev/phonemize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), language }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `Kokoro phonemize error ${r.status}`, details: errText });
    }
    const data = await r.json();
    return res.json({ ok: true, phonemes: data.phonemes, tokens: data.tokens, token_count: data.tokens?.length ?? 0 });
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ ok: false, error: 'Kokoro phonemize timed out' });
    res.status(502).json({ ok: false, error: 'Kokoro unreachable', details: err.message });
  }
});

// Serve index.html as default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
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
const server = app.listen(PORT, () => {
  console.log(`\n🎥 Video Combiner API running at http://localhost:${PORT}`);
  console.log(`📁 Open your browser to: http://localhost:${PORT}`);
  console.log(`🎬 API endpoint: POST http://localhost:${PORT}/api/video-combiner`);
  console.log(`💚 Health check: GET http://localhost:${PORT}/api/health\n`);
  // Start the production scheduler
  schedulerModule.startScheduler(PORT);
});

// Extend socket timeout for long-running caption burn (Whisper + FFmpeg can take minutes)
server.setTimeout(20 * 60 * 1000); // 20 minutes
