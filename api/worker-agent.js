#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  Video Combiner — Remote Worker Agent  (improved v2)
//  Run this on a secondary machine (e.g. T440p) to offload pipeline work.
//
//  Required env vars (set in .env.worker or export before running):
//    MAIN_SERVER_URL   — e.g. http://192.168.0.169:8080
//    WORKER_SECRET     — must match WORKER_SECRET on main server
//    WORKER_ID         — unique name for this machine (default: hostname)
//    WORKER_CAPACITY   — max concurrent jobs (default: 2)
// ─────────────────────────────────────────────────────────────────────────────

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── Load .env.worker (fallback for direct `node api/worker-agent.js`) ─────────
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

const MAIN_URL      = (process.env.MAIN_SERVER_URL || '').replace(/\/$/, '');
const SECRET        = process.env.WORKER_SECRET    || 'videocombine-worker';
const WORKER_ID     = process.env.WORKER_ID        || os.hostname();
const CAPACITY      = parseInt(process.env.WORKER_CAPACITY || '2');
const SERVE_PORT    = parseInt(process.env.SERVE_PORT      || '8182');
const OUTPUT_DIR    = process.env.OUTPUT_DIR || path.join(__dirname, '../output');

// Timing constants
const HEARTBEAT_INT = 10_000;   // ms between heartbeats
const POLL_MIN      = 3_000;    // minimum poll interval
const POLL_MAX      = 60_000;   // maximum poll interval (after many failures)
const LOG_FLUSH_INT = 1_000;    // how often to flush queued log lines
const LOG_QUEUE_MAX = 500;      // max queued lines before dropping oldest

if (!MAIN_URL) {
  console.error('❌  MAIN_SERVER_URL not set. Example: MAIN_SERVER_URL=http://192.168.0.169:8080');
  process.exit(1);
}

// ── Directory setup ───────────────────────────────────────────────────────────
for (const d of [OUTPUT_DIR, '../temp', '../temp_audio', '../temp_mux', '../scripts'].map(
  p => path.isAbsolute(p) ? p : path.join(OUTPUT_DIR, p)
)) {
  fs.mkdirSync(d, { recursive: true });
}

// ── State ─────────────────────────────────────────────────────────────────────
const runningJobs  = new Map();  // jobId → { job }
const logQueue     = [];         // { jobId, line }[] — buffered log lines
let   serverOnline = false;      // updated by heartbeat
let   pollBackoff  = POLL_MIN;   // current poll interval (exponential backoff)
let   pollTimer    = null;
let   workerStats  = { jobs_done: 0, jobs_failed: 0, started_at: Date.now() };

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function api(method, urlPath, body, timeoutMs = 15_000) {
  const url  = `${MAIN_URL}${urlPath}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = {
      method,
      headers: {
        'Content-Type':    'application/json',
        'x-worker-secret': SECRET,
      },
      signal: ctrl.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Log queue — fire-and-forget with retry buffer ─────────────────────────────
function queueLog(jobId, line) {
  process.stdout.write(`  [${jobId.slice(-6)}] ${line}\n`);
  logQueue.push({ jobId, line: String(line) });
  if (logQueue.length > LOG_QUEUE_MAX) logQueue.splice(0, logQueue.length - LOG_QUEUE_MAX);
}

async function flushLogs() {
  if (logQueue.length === 0 || !serverOnline) return;

  // Group by jobId for batch sends (reduces HTTP calls)
  const byJob = {};
  for (const entry of logQueue.splice(0)) {
    (byJob[entry.jobId] = byJob[entry.jobId] || []).push(entry.line);
  }

  for (const [jobId, lines] of Object.entries(byJob)) {
    try {
      await api('POST', '/api/workers/log', { worker_id: WORKER_ID, job_id: jobId, lines });
    } catch (_) {
      // Put lines back at front of queue (up to cap)
      for (let i = lines.length - 1; i >= 0; i--) logQueue.unshift({ jobId, line: lines[i] });
      if (logQueue.length > LOG_QUEUE_MAX) logQueue.length = LOG_QUEUE_MAX;
    }
  }
}

setInterval(flushLogs, LOG_FLUSH_INT);

// ── Helper: single log call (queued) ─────────────────────────────────────────
function sendLog(jobId, line) {
  queueLog(jobId, line);
}

// ── Register / heartbeat ──────────────────────────────────────────────────────
async function register() {
  try {
    await api('POST', '/api/workers/register', {
      worker_id: WORKER_ID,
      host:      getLocalIP(),
      capacity:  CAPACITY,
      running:   [...runningJobs.keys()],
      stats:     workerStats,
    });
    if (!serverOnline) {
      log('✅ Connected to main server');
    }
    serverOnline = true;
    resetPollBackoff();
  } catch (e) {
    if (serverOnline) log('⚠️  Lost connection to main server:', e.message);
    serverOnline = false;
    increasePollBackoff();
  }
}

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) return iface.address;
  }
  return '127.0.0.1';
}

// ── Exponential backoff helpers ───────────────────────────────────────────────
function resetPollBackoff() {
  if (pollBackoff !== POLL_MIN) {
    pollBackoff = POLL_MIN;
    reschedulePoll();
  }
}

function increasePollBackoff() {
  const next = Math.min(pollBackoff * 2, POLL_MAX);
  if (next !== pollBackoff) {
    pollBackoff = next;
    reschedulePoll();
    log(`⏳ Poll backoff: ${pollBackoff / 1000}s`);
  }
}

function reschedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(pollCycle, pollBackoff);
}

// ── Push file to main server ──────────────────────────────────────────────────
async function pushFileToMain(filePath, filename, jobId) {
  const fileSize = fs.statSync(filePath).size;
  log(`  Pushing ${filename} (${(fileSize / 1048576).toFixed(1)} MB)…`);

  const boundary = `----WorkerBoundary${Date.now()}`;
  const header   = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: video/mp4\r\n\r\n`
  );
  const footer    = Buffer.from(`\r\n--${boundary}--\r\n`);
  const totalSize = header.length + fileSize + footer.length;

  const { Readable } = require('stream');
  const fileStream   = fs.createReadStream(filePath);
  let partIdx = 0;
  const parts = [header, fileStream, footer];
  const combinedStream = new Readable({
    read() {
      if (partIdx >= parts.length) { this.push(null); return; }
      const part = parts[partIdx++];
      if (Buffer.isBuffer(part)) { this.push(part); }
      else {
        part.on('data',  chunk => this.push(chunk));
        part.on('end',   ()    => this.read());
        part.on('error', e    => this.destroy(e));
      }
    }
  });

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10 * 60_000);
  try {
    const resp = await fetch(`${MAIN_URL}/api/workers/upload`, {
      method:  'POST',
      headers: {
        'Content-Type':    `multipart/form-data; boundary=${boundary}`,
        'Content-Length':  String(totalSize),
        'x-worker-secret': SECRET,
        'x-job-id':        jobId,
        'x-worker-id':     WORKER_ID,
      },
      body:   combinedStream,
      duplex: 'half',
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Upload rejected');
    return data.url;
  } finally {
    clearTimeout(timer);
  }
}

// ── Fallback pull-mode file server ────────────────────────────────────────────
const fileServer = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
  const fp   = path.join(OUTPUT_DIR, path.basename(name));
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(fp).size });
  fs.createReadStream(fp).pipe(res);
});

// ── Job pipeline ──────────────────────────────────────────────────────────────
async function runJob(job) {
  const jobId = job.id;
  log(`▶ Starting "${job.name}" (${jobId})`);

  const logger = (line) => sendLog(jobId, String(line));

  try {
    // Step 1: Script
    let script = job._cached_script || null;
    if (!script && job.steps?.generate_script !== false) {
      logger('📝 Generating script…');
      const sg = require('./script-generator');
      script   = await sg.generateScript({
        topic:            job.topic || job.niche || 'general',
        niche:            job.niche || '',
        tone:             job.tone  || 'informative',
        style:            job.style || 'storytelling',
        duration_minutes: job.duration_minutes || 2,
        platform:         job.platform || 'YouTube',
        goal:             job.goal     || 'grow audience',
        logger,
        env: process.env,
      });
      logger(`✅ Script: "${script.title}" (${script.scenes?.length || 0} scenes)`);
    }

    // Step 2: Voiceover
    let audioPath = null;
    if (job.steps?.voiceover !== false && script) {
      logger('🎤 Synthesising voiceover…');
      const tts = require('./tts-utils');
      audioPath = await tts.synthesiseScript({ script, job, logger, env: process.env });
      logger(`✅ Audio: ${path.basename(audioPath)}`);
    }

    // Step 3: Footage
    let footage = null;
    if (job.steps?.find_footage !== false && script) {
      logger('🔍 Finding footage…');
      const ff = require('./footage-finder');
      footage  = await ff.findFootageForScenes(script.scenes || [], { job, logger, env: process.env });
      logger(`✅ Footage: ${footage?.length || 0} clips`);
    }

    // Step 4: Combine
    let outputPath = null;
    if (job.steps?.combine !== false && audioPath && footage) {
      logger('🎬 Combining video…');
      const vc  = require('./video-combiner');
      outputPath = await vc.combineVideo({ script, audioPath, footage, job, logger, env: process.env });
      logger(`✅ Video: ${path.basename(outputPath)}`);
    }

    // Step 5: Transfer
    const outputFilename = outputPath ? path.basename(outputPath) : null;
    let transferredUrl   = null;

    if (outputPath && outputFilename) {
      logger('📤 Uploading video to main server…');
      try {
        transferredUrl = await pushFileToMain(outputPath, outputFilename, jobId);
        logger(`✅ Transfer complete: ${outputFilename}`);
      } catch (e) {
        logger(`⚠️  Push failed (${e.message}) — falling back to pull mode`);
        transferredUrl = `http://${getLocalIP()}:${SERVE_PORT}/${encodeURIComponent(outputFilename)}`;
        if (!fileServer.listening) {
          fileServer.listen(SERVE_PORT, () => log(`📁 File server on :${SERVE_PORT}`));
        }
      }
    }

    // Flush remaining logs before reporting done
    await flushLogs();

    await api('POST', '/api/workers/complete', {
      worker_id:  WORKER_ID,
      job_id:     jobId,
      status:     'completed',
      output:     { video_path: outputPath, video_url: transferredUrl, video_filename: outputFilename },
      stats:      workerStats,
    });

    workerStats.jobs_done++;
    log(`✅ "${job.name}" done → ${outputFilename || '(no video)'}`);

  } catch (err) {
    log(`❌ "${job.name}" failed: ${err.message}`);
    logger(`❌ Error: ${err.message}`);
    await flushLogs();
    try {
      await api('POST', '/api/workers/complete', {
        worker_id: WORKER_ID,
        job_id:    jobId,
        status:    'failed',
        error:     err.message,
        stats:     workerStats,
      });
    } catch (_) {}
    workerStats.jobs_failed++;
  } finally {
    runningJobs.delete(jobId);
  }
}

// ── Startup reconciliation ────────────────────────────────────────────────────
// On restart, check if there are jobs the server thinks we're running.
// If we have no local state for them, ask server to release them.
async function reconcileOnStartup() {
  try {
    // Get current job list — look for jobs claimed by us
    const url = `${MAIN_URL}/api/scheduler/jobs`;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return;
    const data = await r.json();
    const jobs = data.jobs || [];
    const orphans = jobs.filter(j => j._claimed_by === WORKER_ID && j.status === 'running');
    for (const j of orphans) {
      if (!runningJobs.has(j.id)) {
        log(`⚠️  Orphan job "${j.name}" — releasing back to pool`);
        await api('POST', '/api/workers/complete', {
          worker_id: WORKER_ID,
          job_id:    j.id,
          status:    'failed',
          error:     'Worker restarted — job orphaned',
        }).catch(() => {});
      }
    }
    if (orphans.length > 0) log(`Reconciled ${orphans.length} orphan job(s)`);
  } catch (_) {
    // Not critical — main server may not be up yet
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function pollCycle() {
  pollTimer = null;

  if (!serverOnline) {
    reschedulePoll();
    return;
  }

  if (runningJobs.size >= CAPACITY) {
    // At capacity — poll less frequently while busy
    pollTimer = setTimeout(pollCycle, POLL_MIN * 2);
    return;
  }

  try {
    const data = await api(
      'GET',
      `/api/workers/poll?worker_id=${encodeURIComponent(WORKER_ID)}&capacity=${CAPACITY - runningJobs.size}`
    );

    if (data.reason === 'at_capacity') {
      // Server confirmed we're busy — don't hammer
      pollTimer = setTimeout(pollCycle, POLL_MIN * 3);
      return;
    }

    if (data.ok && data.job) {
      resetPollBackoff();
      const job = data.job;
      runningJobs.set(job.id, { job });
      runJob(job); // async — poll loop continues immediately
    }
  } catch (e) {
    log(`⚠️  Poll error: ${e.message}`);
    increasePollBackoff();
    reschedulePoll();
    return;
  }

  // Schedule next poll
  reschedulePoll();
}

// ── Logging helper ────────────────────────────────────────────────────────────
function log(...args) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}][${WORKER_ID}]`, ...args);
}

// ── Main ──────────────────────────────────────────────────────────────────────
log('🚀 Worker agent v2 starting');
log(`   ID:       ${WORKER_ID}`);
log(`   Capacity: ${CAPACITY} concurrent jobs`);
log(`   Main:     ${MAIN_URL}`);
log(`   Output:   ${OUTPUT_DIR}`);
log('');

// Start heartbeat (also serves as reconnect loop when server is down)
register();
setInterval(register, HEARTBEAT_INT);

// Reconcile orphaned jobs after initial register has had a chance to connect
setTimeout(async () => {
  if (serverOnline) await reconcileOnStartup();
}, 3_000);

// Start poll cycle
pollTimer = setTimeout(pollCycle, 2_000); // short initial delay

process.on('SIGINT',  () => { log('Shutting down…'); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down…'); process.exit(0); });
process.on('uncaughtException', e => {
  log('⚠️  Uncaught exception:', e.message);
  // Don't crash — worker should keep running
});
process.on('unhandledRejection', (reason) => {
  log('⚠️  Unhandled rejection:', reason?.message || reason);
});
