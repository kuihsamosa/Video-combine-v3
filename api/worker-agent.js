#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  Video Combiner — Remote Worker Agent
//  Run this on a secondary machine (e.g. T440p) to offload pipeline work.
//
//  Required env vars (set in .env or export before running):
//    MAIN_SERVER_URL   — e.g. http://192.168.0.169:8080
//    WORKER_SECRET     — must match WORKER_SECRET on main server (default: videocombine-worker)
//    WORKER_ID         — unique name for this machine (default: hostname)
//    WORKER_CAPACITY   — max concurrent jobs (default: 2)
//
//  Optional:
//    OUTPUT_DIR        — where to write videos locally before sending back
//    SERVE_PORT        — HTTP port to serve finished files (default: 8182)
//    OMNIVOICE_PORT    — local TTS port (default: 8881)
//    GROQ_API_KEY      — LLM key (can differ from main machine)
//    PEXELS_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

// On Windows, env is loaded by worker.ps1 before spawning node.
// On Linux/Mac, env is loaded by worker.sh via `source .env.worker`.
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// Load .env.worker manually as a fallback (useful when running `node api/worker-agent.js` directly)
const envWorkerPath = path.join(__dirname, '../.env.worker');
if (fs.existsSync(envWorkerPath) && !process.env.MAIN_SERVER_URL) {
  fs.readFileSync(envWorkerPath, 'utf8')
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
    .forEach(l => {
      const [k, ...rest] = l.split('=');
      const v = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
      if (k && v && !process.env[k.trim()]) process.env[k.trim()] = v;
    });
}

const MAIN_URL        = (process.env.MAIN_SERVER_URL || '').replace(/\/$/, '');
const SECRET          = process.env.WORKER_SECRET || 'videocombine-worker';
const WORKER_ID       = process.env.WORKER_ID     || os.hostname();
const CAPACITY        = parseInt(process.env.WORKER_CAPACITY || '2');
const SERVE_PORT      = parseInt(process.env.SERVE_PORT      || '8182');
const OUTPUT_DIR      = process.env.OUTPUT_DIR    || path.join(__dirname, '../output');
const POLL_INTERVAL   = 5_000;  // ms between polls when idle
const HEARTBEAT_INT   = 10_000; // ms between registration heartbeats

if (!MAIN_URL) {
  console.error('❌  MAIN_SERVER_URL is not set. Example: MAIN_SERVER_URL=http://192.168.0.169:8080');
  process.exit(1);
}

fs.mkdirSync(OUTPUT_DIR,            { recursive: true });
fs.mkdirSync(path.join(OUTPUT_DIR, '../temp'),       { recursive: true });
fs.mkdirSync(path.join(OUTPUT_DIR, '../temp_audio'), { recursive: true });
fs.mkdirSync(path.join(OUTPUT_DIR, '../temp_mux'),   { recursive: true });
fs.mkdirSync(path.join(OUTPUT_DIR, '../scripts'),    { recursive: true });

// ── Running state ─────────────────────────────────────────────────────────────
const runningJobs = new Map(); // jobId → { job, abortController }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function api(method, path_, body) {
  const url  = `${MAIN_URL}${path_}`;
  const opts = {
    method,
    headers: {
      'Content-Type':    'application/json',
      'x-worker-secret': SECRET,
    },
    signal: AbortSignal.timeout(15_000),
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

// ── Push-based file transfer (no inbound firewall rule needed) ────────────────
// Worker POSTs the video as a multipart/form-data upload to the main server.
// The main server saves it directly into its output directory.
async function pushFileToMain(filePath, filename, jobId) {
  const fileSize = fs.statSync(filePath).size;
  log(`  Pushing ${filename} (${(fileSize / 1048576).toFixed(1)} MB) to main server…`);

  // Use Node 18+ built-in fetch with a ReadableStream body
  // We build a simple multipart body manually (no external deps)
  const boundary = `----WorkerBoundary${Date.now()}`;
  const header   = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: video/mp4\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const totalSize = header.length + fileSize + footer.length;

  const { Readable } = require('stream');
  const fileStream = fs.createReadStream(filePath);

  // Concatenate header + file + footer as a single readable
  const parts = [header, fileStream, footer];
  let partIdx = 0;
  const combinedStream = new Readable({
    read() {
      if (partIdx >= parts.length) { this.push(null); return; }
      const part = parts[partIdx++];
      if (Buffer.isBuffer(part)) { this.push(part); }
      else {
        part.on('data', chunk => this.push(chunk));
        part.on('end',  ()    => this.read());
        part.on('error', e   => this.destroy(e));
      }
    }
  });

  const resp = await fetch(`${MAIN_URL}/api/workers/upload`, {
    method:  'POST',
    headers: {
      'Content-Type':    `multipart/form-data; boundary=${boundary}`,
      'Content-Length':  String(totalSize),
      'x-worker-secret': SECRET,
      'x-job-id':        jobId,
      'x-worker-id':     WORKER_ID,
    },
    body:    combinedStream,
    duplex:  'half',          // required for streaming body in Node fetch
    signal:  AbortSignal.timeout(10 * 60_000), // 10 min timeout for large files
  });

  if (!resp.ok) throw new Error(`Upload failed: HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Upload rejected');
  return data.url; // main server returns the local URL
}

// ── Fallback pull-mode file server (only used if push fails & port is open) ───
const fileServer = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
  const fp   = path.join(OUTPUT_DIR, path.basename(name)); // basename prevents path traversal
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(fp).size });
  fs.createReadStream(fp).pipe(res);
});
// File server starts lazily only if push transfer fails (see runJob below)

// ── Logging ───────────────────────────────────────────────────────────────────
function log(...args) {
  console.log(`[${WORKER_ID}]`, ...args);
}

async function sendLog(jobId, line) {
  process.stdout.write(`  » ${line}\n`);
  await api('POST', '/api/workers/log', { worker_id: WORKER_ID, job_id: jobId, line }).catch(() => {});
}

// ── Register / heartbeat ──────────────────────────────────────────────────────
async function register() {
  try {
    await api('POST', '/api/workers/register', {
      worker_id: WORKER_ID,
      host:      getLocalIP(),
      capacity:  CAPACITY,
      running:   [...runningJobs.keys()],
    });
  } catch (e) {
    log('⚠️  Could not reach main server:', e.message);
  }
}

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  }
  return '127.0.0.1';
}

// ── Pipeline runner ───────────────────────────────────────────────────────────
async function runJob(job) {
  const jobId = job.id;
  log(`▶ Starting "${job.name}" (${jobId})`);

  // Patch process.env with job-level overrides if present
  // (so the pipeline modules pick up the right keys)
  const env = process.env;

  // Build a logger that streams lines back to main
  const logger = (line) => sendLog(jobId, String(line));

  try {
    // ── Step 1: Script generation (or use pre-cached) ──────────────────────
    let script = job._cached_script || null;
    if (!script && job.steps?.generate_script !== false) {
      logger('📝 Generating script…');
      const sg = require('./script-generator');
      script   = await sg.generateScript({
        topic: job.topic || job.niche || 'general',
        niche: job.niche || '',
        tone:  job.tone  || 'informative',
        style: job.style || 'storytelling',
        duration_minutes: job.duration_minutes || 2,
        platform: job.platform || 'YouTube',
        goal:     job.goal     || 'grow audience',
        logger,
        env,
      });
      logger(`✅ Script: "${script.title}" (${script.scenes?.length || 0} scenes)`);
    }

    // ── Step 2: Voiceover ──────────────────────────────────────────────────
    let audioPath = null;
    if (job.steps?.voiceover !== false && script) {
      logger('🎤 Synthesising voiceover…');
      const tts = require('./tts-utils');
      audioPath = await tts.synthesiseScript({ script, job, logger, env });
      logger(`✅ Audio: ${path.basename(audioPath)}`);
    }

    // ── Step 3: Find footage ───────────────────────────────────────────────
    let footage = null;
    if (job.steps?.find_footage !== false && script) {
      logger('🔍 Finding footage…');
      const ff = require('./footage-finder');
      footage  = await ff.findFootageForScenes(script.scenes || [], { job, logger, env });
      logger(`✅ Footage: ${footage?.length || 0} clips`);
    }

    // ── Step 4: Combine ────────────────────────────────────────────────────
    let outputPath = null;
    if (job.steps?.combine !== false && audioPath && footage) {
      logger('🎬 Combining video…');
      const vc  = require('./video-combiner');
      outputPath = await vc.combineVideo({ script, audioPath, footage, job, logger, env });
      logger(`✅ Video: ${path.basename(outputPath)}`);
    }

    // ── Transfer output back to main server ───────────────────────────────
    const outputFilename = outputPath ? path.basename(outputPath) : null;
    let transferredUrl   = null;

    if (outputPath && outputFilename) {
      logger('📤 Uploading video to main server…');
      try {
        transferredUrl = await pushFileToMain(outputPath, outputFilename, jobId);
        logger(`✅ Transfer complete: ${outputFilename}`);
      } catch (e) {
        logger(`⚠️  Transfer failed (${e.message}) — main server will try to pull instead`);
        // Fallback: expose via local file server (requires firewall rule)
        transferredUrl = `http://${getLocalIP()}:${SERVE_PORT}/${encodeURIComponent(outputFilename)}`;
        fileServer.listen(SERVE_PORT).catch(() => {}); // start if not already running
      }
    }

    await api('POST', '/api/workers/complete', {
      worker_id:  WORKER_ID,
      job_id:     jobId,
      status:     'completed',
      output:     { video_path: outputPath, video_url: transferredUrl, video_filename: outputFilename },
    });

    log(`✅ "${job.name}" done → ${outputFilename || '(no video)'}`);
  } catch (err) {
    log(`❌ "${job.name}" failed:`, err.message);
    logger(`❌ Error: ${err.message}`);
    await api('POST', '/api/workers/complete', {
      worker_id: WORKER_ID,
      job_id:    jobId,
      status:    'failed',
      error:     err.message,
    }).catch(() => {});
  } finally {
    runningJobs.delete(jobId);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function poll() {
  if (runningJobs.size >= CAPACITY) return; // already at capacity

  let data;
  try {
    data = await api('GET', `/api/workers/poll?worker_id=${encodeURIComponent(WORKER_ID)}&capacity=${CAPACITY - runningJobs.size}`);
  } catch (e) {
    log('⚠️  Poll failed:', e.message);
    return;
  }

  if (!data.ok || !data.job) return; // nothing to do

  const job = data.job;
  runningJobs.set(job.id, { job });
  runJob(job); // fire and forget — poll loop continues
}

// ── Main ──────────────────────────────────────────────────────────────────────
log(`🚀 Worker agent starting`);
log(`   ID:       ${WORKER_ID}`);
log(`   Capacity: ${CAPACITY} concurrent jobs`);
log(`   Main:     ${MAIN_URL}`);
log(`   Output:   ${OUTPUT_DIR}`);
log('');

register();
setInterval(register, HEARTBEAT_INT);
setInterval(poll,     POLL_INTERVAL);
poll(); // immediate first poll

process.on('SIGINT',  () => { log('Shutting down…'); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down…'); process.exit(0); });
