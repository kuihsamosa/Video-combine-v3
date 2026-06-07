// Content Production Scheduler
// Orchestrates: Brainstorm → Script → Voiceover → Footage → Combine
// Jobs persist in scheduler-jobs.json. A background tick checks every 60s.

// Node 16 compatibility: ensure global fetch is available
if (typeof fetch === 'undefined') { require('./script-generator'); } // polyfill is installed as side-effect

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');

const { brainstormIdeas, validateIdea } = require('./planner');
const { generateScript }                = require('./script-generator');
const { findFootageForScenes }          = require('./footage-finder');
const { preprocessTTS, chunkTTS, stitchWavBuffers, findDataOffset } = require('./tts-utils');

const JOBS_FILE    = path.join(__dirname, '../scheduler-jobs.json');
const OUTPUTS_DIR  = path.join(__dirname, '../output');
const KOKOROURL    = process.env.KOKORO_URL || 'http://localhost:8880';

// ── In-memory run log store (keyed by runId) ──────────────────────────────────
const runLogs    = {};   // runId → string[]
const runEmitters = {}; // runId → Set of SSE res objects
let   schedulerPort = 8080;

function setPort(p) { schedulerPort = p; }

// ── Persistent job store ──────────────────────────────────────────────────────
function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return [];
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) || [];
  } catch (_) { return []; }
}

function saveJobs(jobs) {
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2)); } catch (_) {}
}

function getJob(id) { return loadJobs().find(j => j.id === id) || null; }

function upsertJob(job) {
  const jobs = loadJobs();
  const idx  = jobs.findIndex(j => j.id === job.id);
  if (idx === -1) jobs.push(job); else jobs[idx] = job;
  saveJobs(jobs);
  return job;
}

function deleteJob(id) {
  const jobs = loadJobs().filter(j => j.id !== id);
  saveJobs(jobs);
}

// ── Schedule computation ──────────────────────────────────────────────────────
function computeNextRun(schedule, fromNow = true) {
  if (!schedule || schedule.type === 'manual') return null;

  const now = fromNow ? new Date() : new Date();

  if (schedule.type === 'hourly') {
    const h = Math.max(1, parseInt(schedule.interval_hours) || 1);
    return now.getTime() + h * 3_600_000;
  }

  if (schedule.type === 'daily') {
    const [hh, mm] = (schedule.time || '09:00').split(':').map(Number);
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (schedule.type === 'weekly') {
    const [hh, mm] = (schedule.time || '09:00').split(':').map(Number);
    const target   = parseInt(schedule.day_of_week ?? 1); // 0=Sun…6=Sat
    const next     = new Date(now);
    next.setHours(hh, mm, 0, 0);
    let days = (target - now.getDay() + 7) % 7;
    if (days === 0 && next <= now) days = 7;
    next.setDate(next.getDate() + days);
    return next.getTime();
  }

  return null;
}

function fmtMs(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

// ── Run log helpers ───────────────────────────────────────────────────────────
function runLog(runId, msg) {
  if (!runLogs[runId]) runLogs[runId] = [];
  const line = `[${new Date().toISOString()}] ${msg}`;
  runLogs[runId].push(line);
  // Push to any live SSE subscribers
  const clients = runEmitters[runId];
  if (clients) clients.forEach(res => {
    try { res.write(`data: ${JSON.stringify({ log: line })}\n\n`); } catch (_) {}
  });
}

function subscribeRunLog(runId, res) {
  if (!runEmitters[runId]) runEmitters[runId] = new Set();
  runEmitters[runId].add(res);
  // Replay existing logs
  (runLogs[runId] || []).forEach(line => {
    res.write(`data: ${JSON.stringify({ log: line })}\n\n`);
  });
}

function unsubscribeRunLog(runId, res) {
  runEmitters[runId]?.delete(res);
}

function finaliseRun(runId, status, output) {
  const clients = runEmitters[runId];
  if (clients) {
    const msg = JSON.stringify({ done: true, status, output });
    clients.forEach(res => { try { res.write(`data: ${msg}\n\n`); res.end(); } catch (_) {} });
    clients.clear();
  }
  // Keep logs for 1 hour then GC
  setTimeout(() => { delete runLogs[runId]; delete runEmitters[runId]; }, 3_600_000);
}

// ── TTS helper: call Kokoro directly, return WAV Buffer ───────────────────────
async function generateTTS(text, voice = 'narrator_warm', speed = 0.88, logger) {
  const VOICE_PRESETS = {
    'narrator_warm':      'af_heart(0.65)+af_jessica(0.35)',
    'narrator_confident': 'am_adam(0.55)+am_michael(0.45)',
    'narrator_calm':      'af_bella(0.6)+af_heart(0.4)',
    'narrator_energetic': 'am_fenrir(0.6)+am_puck(0.4)',
    'narrator_deep':      'bm_george(0.7)+am_adam(0.3)',
    'narrator_crisp':     'bf_emma(0.55)+af_jessica(0.45)',
  };
  const resolvedVoice = VOICE_PRESETS[voice] || voice || 'af_heart';
  const cleaned = preprocessTTS(text);
  const chunks  = chunkTTS(cleaned, 300);  // 300 chars → better prosody per chunk
  logger(`🎙️  TTS: ${chunks.length} chunk(s), voice=${resolvedVoice}`);

  const wavChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const { text: chunkText, paragraphEnd } = chunks[i];
    const body = JSON.stringify({
      model:           'kokoro',
      input:           chunkText,
      voice:           resolvedVoice,
      speed,
      response_format: 'wav',
      stream:          false,
      normalization_options: {
        unit:                      'paragraph',
        email_normalization:       true,
        phone_normalization:       true,
        replace_remaining_symbols: true,
      },
    });
    const r = await fetch(`${KOKOROURL}/v1/audio/speech`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'audio/wav' },
      body,
      signal:  AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`Kokoro ${r.status} on chunk ${i + 1}`);
    const buf = Buffer.from(await r.arrayBuffer());
    wavChunks.push({ buf, paragraphEnd });
    logger(`   ✅ Chunk ${i+1}/${chunks.length} — ${(buf.length/1024).toFixed(0)} KB`);
  }

  // Stitch with 350ms silence at paragraph breaks for natural breathing room
  return stitchWavBuffers(wavChunks, 350);
}

// ── Run the full pipeline for one job ────────────────────────────────────────
async function runJob(jobId) {
  const runId  = crypto.randomBytes(4).toString('hex');
  const log    = (msg) => runLog(runId, msg);
  let   job    = getJob(jobId);
  if (!job) return;

  // Mark job as running
  job = { ...job, status: 'running', current_run_id: runId };
  upsertJob(job);

  const startMs = Date.now();
  const output  = { ideas: null, idea: null, script: null, audio_path: null, clips: [], video_path: null, run_id: runId };

  try {
    log(`🚀 Job "${job.name}" starting (run ${runId})`);

    // ── Step 1: Brainstorm ────────────────────────────────────────────────────
    if (job.steps?.brainstorm) {
      log('💡 Step 1: Brainstorming ideas…');
      const ideas = await brainstormIdeas({
        niche:        job.niche,
        platform:     job.platform || 'YouTube',
        goal:         job.goal || 'grow audience',
        tone:         job.tone || '',
        count:        5,
        groq_api_key: process.env.GROQ_API_KEY,
      }, { log });

      // Pick best by viral_score
      ideas.sort((a, b) => (b.viral_score || 0) - (a.viral_score || 0));
      output.ideas = ideas;

      // Validate the top idea
      let picked = ideas[0];
      if (job.steps?.validate) {
        log(`🔍 Validating top idea: "${picked.title}"…`);
        const val = await validateIdea(picked, {
          niche:        job.niche,
          platform:     job.platform,
          groq_api_key: process.env.GROQ_API_KEY,
        }, { log });
        if (val.verdict === 'skip' && ideas[1]) {
          log(`   ⚠️  Top idea rejected — trying #2: "${ideas[1].title}"`);
          picked = ideas[1];
        }
        if (val.refined_title) picked.title = val.refined_title;
      }

      output.idea = picked;
      log(`✅ Idea selected: "${picked.title}"`);
    }

    // ── Step 2: Generate script ───────────────────────────────────────────────
    if (job.steps?.generate_script) {
      const topic = output.idea?.title || job.topic || job.niche;
      log(`📝 Step 2: Generating script for "${topic}"…`);

      const result = await generateScript({
        topic,
        niche:            job.niche || output.idea?.niche || '',
        tone:             job.tone  || output.idea?.tone  || 'informative',
        style:            job.style || output.idea?.style || 'storytelling',
        duration_minutes: job.duration_minutes || output.idea?.duration_minutes || 2,
        model:            job.model || 'llama-3.3-70b-versatile',
        env:              process.env,
      }, { log });

      output.script = result.script;
      log(`✅ Script: "${result.script.title}" — ${result.script.narration?.split(' ').length || 0} words`);
    }

    // ── Step 3: Voiceover (TTS) ───────────────────────────────────────────────
    if (job.steps?.voiceover && output.script?.narration) {
      log(`🎙️  Step 3: Generating voiceover…`);
      const wavBuf = await generateTTS(
        output.script.narration,
        job.voice || 'narrator_warm',
        job.speed || 0.92,
        log,
      );

      if (!fs.existsSync(os.tmpdir())) fs.mkdirSync(os.tmpdir(), { recursive: true });
      const audioPath = path.join(os.tmpdir(), `sched_${runId}.wav`);
      fs.writeFileSync(audioPath, wavBuf);
      output.audio_path = audioPath;
      log(`✅ Voiceover: ${(wavBuf.length / 1048576).toFixed(1)} MB → ${audioPath}`);
    }

    // ── Step 4: Find footage ──────────────────────────────────────────────────
    if (job.steps?.find_footage && output.script?.scenes?.length) {
      log(`🎥 Step 4: Finding footage for ${output.script.scenes.length} scenes…`);
      const clips = await findFootageForScenes(
        output.script.scenes,
        process.env,
        { log },
        job.clips_per_scene || 2,
        job.orientation || 'landscape',
        job.use_youtube || false,
        job.use_pexels  !== false,
        job.use_pixabay !== false,
        job.yt_quality  || '720',
      );
      output.clips = clips;
      log(`✅ Footage: ${clips.length} clip(s) downloaded`);
    }

    // ── Step 5: Combine (video-combiner + mux) ────────────────────────────────
    if (job.steps?.combine && output.clips.length && output.audio_path) {
      log('🎬 Step 5: Combining video + audio…');

      // Use combineVideos / extractSegment directly from video-combiner
      const { combineVideos, extractSegment } = (() => {
        try { return require('./video-combiner'); } catch(_) { return {}; }
      })();
      const { getVideoPreset } = require('./app-config');
      const resolvedPreset = getVideoPreset('balanced');

      // We have localPath on each clip — use combineVideos directly if available
      if (typeof combineVideos === 'function') {
        // Extract segments first
        const { getSegmentDuration } = require('./video-combiner');
        const segPaths = [];
        const tmpDir   = path.join(os.tmpdir(), `sched_seg_${runId}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        for (let i = 0; i < output.clips.length; i++) {
          const clip    = output.clips[i];
          const segOut  = path.join(tmpDir, `seg_${i}.mp4`);
          try {
            const dur = clip.duration || 4;
            await extractSegment({
              inputPath:       clip.localPath,
              startTime:       0,
              durationSeconds: Math.min(5, dur),
              outputPath:      segOut,
              preset:          resolvedPreset,
              orientation:     job.orientation || 'landscape',
              logger:          { log, error: log },
            });
            segPaths.push(segOut);
          } catch(e) {
            log(`   ⚠️  Segment ${i}: ${e.message}`);
          }
        }

        if (segPaths.length) {
          if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
          const combinedPath = path.join(OUTPUTS_DIR, `sched_combined_${runId}.mp4`);
          const listPath     = path.join(tmpDir, 'list.txt');

          await combineVideos({
            segmentPaths:    segPaths,
            listPath,
            outputPath:      combinedPath,
            preset:          resolvedPreset,
            logger:          { log, error: log },
            outputFormat:    'mp4',
            transition:      'none',
          });

          log('🔊 Muxing video + voiceover…');
          const muxOutPath = path.join(OUTPUTS_DIR, `sched_final_${runId}.mp4`);
          const { runFfmpeg, runFfprobeDurationSeconds } = require('./ffmpeg');
          const audioDur = await runFfprobeDurationSeconds(output.audio_path, {}).catch(() => 0);
          const fadeStart = Math.max(0, audioDur - 2);
          const muxArgs = [
            '-y',
            '-i', combinedPath,
            '-i', output.audio_path,
            '-filter_complex', [
              `[0:v]trim=duration=${audioDur.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,fade=t=out:st=${fadeStart.toFixed(3)}:d=2:color=black[vout]`,
              `[1:a]asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart.toFixed(3)}:d=2[aout]`,
            ].join(';'),
            '-map', '[vout]', '-map', '[aout]',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '192k',
            muxOutPath,
          ];
          await runFfmpeg(muxArgs, { logger: { log, error: log } });

          output.video_path = muxOutPath;
          const sizeMB = (fs.statSync(muxOutPath).size / 1048576).toFixed(1);
          log(`✅ Final video: ${muxOutPath} (${sizeMB} MB)`);

          // Clean up segments
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
        } else {
          log('⚠️  No valid segments — skipping combine');
        }
      } else {
        log('⚠️  video-combiner not available — skipping combine');
      }
    }

    // ── Done ──────────────────────────────────────────────────────────────────
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    log(`🎉 Job "${job.name}" completed in ${elapsed}s`);

    const run = {
      id:         runId,
      status:     'completed',
      started_at: new Date(startMs).toISOString(),
      elapsed_s:  parseFloat(elapsed),
      idea_title: output.idea?.title || output.script?.title || null,
      video_path: output.video_path,
      audio_path: output.audio_path,
      clip_count: output.clips.length,
    };

    // Update job record
    job = getJob(jobId) || job;
    job.status       = 'idle';
    job.last_run     = new Date().toISOString();
    job.last_run_id  = runId;
    job.current_run_id = null;
    job.next_run_ms  = computeNextRun(job.schedule);
    job.run_history  = [run, ...(job.run_history || [])].slice(0, 10);
    upsertJob(job);
    finaliseRun(runId, 'completed', run);

  } catch (err) {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    log(`❌ Job "${job?.name}" failed after ${elapsed}s: ${err.message}`);
    console.error('[Scheduler]', err);

    const run = {
      id:         runId,
      status:     'error',
      started_at: new Date(startMs).toISOString(),
      elapsed_s:  parseFloat(elapsed),
      error:      err.message,
    };

    job = getJob(jobId) || job;
    job.status       = 'error';
    job.last_run     = new Date().toISOString();
    job.last_run_id  = runId;
    job.current_run_id = null;
    job.next_run_ms  = computeNextRun(job.schedule);
    job.run_history  = [run, ...(job.run_history || [])].slice(0, 10);
    upsertJob(job);
    finaliseRun(runId, 'error', run);
  }
}

// ── Scheduler tick — fires every 60 seconds ───────────────────────────────────
let tickTimer = null;

function startScheduler(port = 8080) {
  schedulerPort = port;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    const now  = Date.now();
    const jobs = loadJobs();
    for (const job of jobs) {
      if (
        job.enabled &&
        job.status !== 'running' &&
        job.next_run_ms &&
        now >= job.next_run_ms
      ) {
        console.log(`[Scheduler] Triggering "${job.name}" (${job.id})`);
        runJob(job.id).catch(console.error);
      }
    }
  }, 60_000);
  console.log('[Scheduler] Tick started');
}

function stopScheduler() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// ── CRUD helpers ──────────────────────────────────────────────────────────────
function createJob(data) {
  const job = {
    id:          crypto.randomBytes(4).toString('hex'),
    name:        data.name || 'Unnamed Job',
    niche:       data.niche || '',
    topic:       data.topic || '',
    platform:    data.platform    || 'YouTube',
    goal:        data.goal        || 'grow audience',
    tone:        data.tone        || 'calm',
    style:       data.style       || 'storytelling',
    duration_minutes: parseInt(data.duration_minutes) || 2,
    orientation: data.orientation || 'landscape',
    voice:       data.voice       || 'narrator_warm',
    speed:       parseFloat(data.speed) || 0.92,
    model:       data.model       || 'llama-3.3-70b-versatile',
    clips_per_scene: parseInt(data.clips_per_scene) || 2,
    use_youtube: !!data.use_youtube,
    use_pexels:  data.use_pexels  !== false,
    use_pixabay: data.use_pixabay !== false,
    steps: {
      brainstorm:      data.steps?.brainstorm      ?? true,
      validate:        data.steps?.validate         ?? true,
      generate_script: data.steps?.generate_script  ?? true,
      voiceover:       data.steps?.voiceover         ?? true,
      find_footage:    data.steps?.find_footage      ?? true,
      combine:         data.steps?.combine            ?? false,
    },
    schedule: {
      type:           data.schedule?.type           || 'manual',
      time:           data.schedule?.time           || '09:00',
      day_of_week:    data.schedule?.day_of_week    ?? 1,
      interval_hours: data.schedule?.interval_hours ?? 24,
    },
    enabled:          data.enabled !== false,
    status:           'idle',
    created_at:       new Date().toISOString(),
    _from_planner:    data._from_planner    || false,
    _planner_idea_id: data._planner_idea_id || null,
    last_run:    null,
    last_run_id: null,
    next_run_ms: null,
    run_history: [],
  };
  job.next_run_ms = computeNextRun(job.schedule);
  upsertJob(job);
  return job;
}

function updateJob(id, data) {
  const job = getJob(id);
  if (!job) return null;
  const updated = {
    ...job,
    ...data,
    id,   // never change id
    steps:    { ...job.steps,    ...(data.steps    || {}) },
    schedule: { ...job.schedule, ...(data.schedule || {}) },
  };
  updated.next_run_ms = computeNextRun(updated.schedule);
  upsertJob(updated);
  return updated;
}

module.exports = {
  loadJobs, createJob, updateJob, deleteJob, getJob,
  runJob, startScheduler, stopScheduler, setPort,
  subscribeRunLog, unsubscribeRunLog,
  computeNextRun, fmtMs,
};
