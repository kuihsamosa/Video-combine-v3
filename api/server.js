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
const { findFootageForScenes, FOOTAGE_DIR } = require('./footage-finder');

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

// ── Stock footage finder ──────────────────────────────────────────────────────
app.post('/api/find-footage', async (req, res) => {
  const { scenes, clips_per_scene = 2 } = req.body || {};
  if (!Array.isArray(scenes) || !scenes.length) {
    return res.status(400).json({ ok: false, error: 'scenes[] array required' });
  }
  if (!process.env.PEXELS_API_KEY && !process.env.PIXABAY_API_KEY) {
    return res.status(500).json({ ok: false, error: 'No footage API key configured. Add PEXELS_API_KEY or PIXABAY_API_KEY to .env (get a free key at pexels.com/api).' });
  }

  const sessionId = crypto.randomBytes(4).toString('hex');
  const logger = createSessionLogger(sessionId);

  try {
    logger.log(`🎥 Finding footage for ${scenes.length} scenes (${clips_per_scene} clip/scene)…`);
    const clips = await findFootageForScenes(scenes, process.env, logger, parseInt(clips_per_scene));
    res.json({ ok: true, session_id: sessionId, clips });
  } catch (err) {
    logger.error(`❌ Footage finder: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    setTimeout(() => cleanupSession(sessionId), 60_000);
  }
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

// Kokoro TTS proxy — streams audio back to client
app.post('/api/tts', async (req, res) => {
  const KOKORO_URL = process.env.KOKORO_URL || 'http://localhost:8880';
  const { text, voice = 'af_heart', speed = 1.0, format = 'wav' } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 50000) {
    return res.status(400).json({ error: 'text too long (max 50000 chars)' });
  }
  try {
    const kokoroRes = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input: text.trim(), voice, speed, response_format: format }),
      signal: AbortSignal.timeout(120000)
    });
    if (!kokoroRes.ok) {
      const errText = await kokoroRes.text().catch(() => '');
      return res.status(502).json({ error: 'Kokoro TTS failed', details: errText });
    }
    const contentType = kokoroRes.headers.get('content-type') || `audio/${format}`;
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="tts.${format}"`);
    const buf = await kokoroRes.arrayBuffer();
    res.send(Buffer.from(buf));
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
app.listen(PORT, () => {
  console.log(`\n🎥 Video Combiner API running at http://localhost:${PORT}`);
  console.log(`📁 Open your browser to: http://localhost:${PORT}`);
  console.log(`🎬 API endpoint: POST http://localhost:${PORT}/api/video-combiner`);
  console.log(`💚 Health check: GET http://localhost:${PORT}/api/health\n`);
});
