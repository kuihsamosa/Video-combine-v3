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

      const jobStyle = job.style || output.idea?.style || 'storytelling';
      const result = await generateScript({
        topic,
        niche:            job.niche || output.idea?.niche || '',
        tone:             job.tone  || output.idea?.tone  || 'informative',
        style:            jobStyle,
        podcast_speakers: jobStyle === 'podcast_dual' ? 2 : 1,
        duration_minutes: job.duration_minutes || output.idea?.duration_minutes || 2,
        model:            job.model || 'llama-3.3-70b-versatile',
        env:              process.env,
      }, { log });

      output.script = result.script;
      log(`✅ Script: "${result.script.title}" — ${result.script.narration?.split(' ').length || 0} words`);
    }

    // ── Step 3: Voiceover (TTS) ───────────────────────────────────────────────
    if (job.steps?.voiceover && output.script?.narration) {
      const isPodcastDual = output.script._podcast_dual || job.style === 'podcast_dual';
      const isPodcast     = output.script._is_podcast   || job.style === 'podcast' || isPodcastDual;

      if (isPodcastDual) {
        // ── Dual-voice podcast: parse HOST/GUEST turns, synthesise each separately ──
        log(`🎙️  Step 3: Generating dual-voice podcast voiceover…`);

        const hostVoice  = job.podcast_host_voice  || job.voice || 'narrator_warm';
        const guestVoice = job.podcast_guest_voice || 'narrator_confident';
        log(`   HOST voice: ${hostVoice}  |  GUEST voice: ${guestVoice}`);

        // Parse turns: each line starting with HOST: or GUEST: is a turn
        const narration = output.script.narration;
        const turns = [];
        for (const line of narration.split('\n')) {
          const hostMatch  = line.match(/^HOST:\s*(.+)/i);
          const guestMatch = line.match(/^GUEST:\s*(.+)/i);
          if (hostMatch)  turns.push({ speaker: 'HOST',  text: hostMatch[1].trim() });
          else if (guestMatch) turns.push({ speaker: 'GUEST', text: guestMatch[1].trim() });
          else if (line.trim() && turns.length > 0) {
            // Continuation of previous turn (no label)
            turns[turns.length - 1].text += ' ' + line.trim();
          }
        }

        if (!turns.length) {
          // No HOST:/GUEST: labels found — treat as single-voice
          log('   ℹ️  No HOST/GUEST labels found — using single voice');
          const wavBuf = await generateTTS(narration, hostVoice, job.speed || 0.90, log);
          const audioPath = path.join(os.tmpdir(), `sched_${runId}.wav`);
          fs.writeFileSync(audioPath, wavBuf);
          output.audio_path = audioPath;
        } else {
          log(`   Parsed ${turns.length} speaker turns (HOST: ${turns.filter(t=>t.speaker==='HOST').length}, GUEST: ${turns.filter(t=>t.speaker==='GUEST').length})`);

          // Synthesise each turn individually, stitch with 200ms gap between speakers
          const wavChunks = [];
          for (let i = 0; i < turns.length; i++) {
            const turn = turns[i];
            const voice = turn.speaker === 'HOST' ? hostVoice : guestVoice;
            log(`   Turn ${i+1}/${turns.length} [${turn.speaker}] — ${turn.text.slice(0,60)}…`);
            try {
              const turnWav = await generateTTS(turn.text, voice, job.speed || 0.90, log);
              // Mark as paragraph end to get inter-turn silence
              wavChunks.push({ buf: turnWav, paragraphEnd: true });
            } catch (e) {
              log(`   ⚠️  TTS failed for turn ${i+1}: ${e.message}`);
            }
          }

          if (!wavChunks.length) throw new Error('All podcast turns failed TTS');
          const stitched = stitchWavBuffers(wavChunks, 400); // 400ms between speaker turns
          const audioPath = path.join(os.tmpdir(), `sched_${runId}.wav`);
          fs.writeFileSync(audioPath, stitched);
          output.audio_path = audioPath;
          log(`✅ Dual-voice voiceover: ${(stitched.length / 1048576).toFixed(1)} MB → ${audioPath}`);
        }
      } else if (isPodcast) {
        // ── Single-host podcast: slightly slower speed, bigger chunk size ──────────
        log(`🎙️  Step 3: Generating podcast voiceover (single host)…`);
        const podcastNarration = output.script.narration
          .replace(/^HOST:\s*/gim, '')   // strip any stray labels
          .replace(/^GUEST:\s*/gim, '');
        const wavBuf = await generateTTS(podcastNarration, job.voice || 'narrator_warm', job.speed || 0.86, log);
        const audioPath = path.join(os.tmpdir(), `sched_${runId}.wav`);
        fs.writeFileSync(audioPath, wavBuf);
        output.audio_path = audioPath;
        log(`✅ Podcast voiceover: ${(wavBuf.length / 1048576).toFixed(1)} MB → ${audioPath}`);
      } else {
        // ── Standard single-voice ─────────────────────────────────────────────────
        log(`🎙️  Step 3: Generating voiceover…`);
        const wavBuf = await generateTTS(
          output.script.narration,
          job.voice || 'narrator_warm',
          job.speed || 0.92,
          log,
        );
        const audioPath = path.join(os.tmpdir(), `sched_${runId}.wav`);
        fs.writeFileSync(audioPath, wavBuf);
        output.audio_path = audioPath;
        log(`✅ Voiceover: ${(wavBuf.length / 1048576).toFixed(1)} MB → ${audioPath}`);
      }
    }

    // ── Step 4: Find footage ──────────────────────────────────────────────────
    if (job.steps?.find_footage && output.script?.scenes?.length) {
      log(`🎥 Step 4: Finding footage for ${output.script.scenes.length} scenes…`);

      // Estimate target duration from audio so footage-finder can top-up if needed
      let targetFootageSecs = (job.duration_minutes || 2) * 60 * 1.3; // 30% headroom
      if (output.audio_path && fs.existsSync(output.audio_path)) {
        try {
          const { runFfprobeDurationSeconds } = require('./ffmpeg');
          const d = await runFfprobeDurationSeconds(output.audio_path, {}).catch(() => 0);
          if (d > 0) targetFootageSecs = d * 1.3;
        } catch (_) {}
      }

      // Smuggle targetDurationSeconds into the clipsPerScene param as a property
      // (avoids changing the function signature which is also used by server.js)
      const clipsParam = Object.assign(job.clips_per_scene || 2, { _targetDurationSeconds: targetFootageSecs });

      const clips = await findFootageForScenes(
        output.script.scenes,
        process.env,
        { log },
        clipsParam,
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

      const { runFfprobeDurationSeconds } = require('./ffmpeg');
      const audioDurForCombine = await runFfprobeDurationSeconds(output.audio_path, {}).catch(() => 0);

      // Use combineVideos / extractSegment directly from video-combiner
      const { combineVideos, extractSegment } = (() => {
        try { return require('./video-combiner'); } catch(_) { return {}; }
      })();
      const { getVideoPreset } = require('./app-config');
      const resolvedPreset = getVideoPreset('balanced');
      const { generateTitleCard, extractChapterMarkers } = require('./title-card-generator');

      // Cinematic color grade applied to every extracted segment
      // High-contrast, slightly desaturated shadows, lifted teal
      const colorGradeFilter = job.color_grade !== false
        ? 'eq=contrast=1.12:brightness=-0.02:saturation=1.15,curves=r=\'0/0 0.5/0.48 1/1\':g=\'0/0 0.5/0.51 1/1\':b=\'0/0 0.5/0.56 1/1\''
        : null;

      // We have localPath on each clip — use combineVideos directly if available
      if (typeof combineVideos === 'function') {
        const tmpDir = path.join(os.tmpdir(), `sched_seg_${runId}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        // ── Extract segments — no-repeat: advance start offset per clip ──────────
        const baseClips = output.clips;
        let segPaths = [];

        // Track how many seconds have been extracted from each clip (by localPath)
        const clipOffsets = new Map(); // localPath → nextStartSeconds

        // Default cut length: 2.5s for high-retention pacing (change per 1.5–3s rule)
        // Can be overridden per job via job.cut_duration_seconds
        const DEFAULT_CUT_SECS = job.cut_duration_seconds ?? 2.5;

        const extractOne = async (clip, idx, cutSecs, startOverride) => {
          const segOut  = path.join(tmpDir, `seg_${idx}.mp4`);
          const clipDur = clip.duration || 30;
          const start   = startOverride ?? (clipOffsets.get(clip.localPath) || 0);
          const avail   = Math.max(0, clipDur - start);
          if (avail < 1) return null; // this clip is exhausted
          const actual  = Math.min(cutSecs, avail);

          // Build extra video filter for color grade if enabled
          const extraVf = colorGradeFilter || null;

          await extractSegment({
            inputPath:       clip.localPath,
            startTime:       start,
            durationSeconds: actual,
            outputPath:      segOut,
            preset:          resolvedPreset,
            orientation:     job.orientation || 'landscape',
            extraVideoFilter: extraVf,
            logger:          { log, error: log },
          });
          clipOffsets.set(clip.localPath, start + actual);
          return segOut;
        };

        // ── Inject title cards between chapter-opening scenes ───────────────────
        const useTitleCards = job.title_cards !== false; // default on
        const chapterMap    = useTitleCards ? extractChapterMarkers(output.script?.scenes || []) : new Map();
        let cardCounter  = 0;

        for (let i = 0; i < baseClips.length; i++) {
          // Check if this scene opens a new chapter → insert title card before its segments
          const sceneId      = baseClips[i].scene_id;
          const chapterTitle = chapterMap.get(sceneId);
          if (useTitleCards && chapterTitle) {
            try {
              const cardPath = path.join(tmpDir, `titlecard_${cardCounter++}.mp4`);
              await generateTitleCard({
                title:        chapterTitle,
                durationSecs: 2.0,
                outputPath:   cardPath,
                orientation:  job.orientation || 'landscape',
                logger:       { log, error: log },
              });
              segPaths.push(cardPath);
              log(`🎬 Chapter card: "${chapterTitle}"`);
            } catch (cardErr) {
              log(`   ⚠️  Title card skipped: ${cardErr.message}`);
            }
          }

          try {
            const segOut = await extractOne(baseClips[i], i, DEFAULT_CUT_SECS);
            if (segOut) segPaths.push(segOut);
          } catch(e) {
            log(`   ⚠️  Segment ${i}: ${e.message}`);
          }
        }

        // ── Coverage check: extract more from untapped parts of each clip ────────
        if (audioDurForCombine > 0 && segPaths.length > 0) {
          // Probe total segment duration
          let totalSegSecs = 0;
          for (const p of segPaths) {
            totalSegSecs += await runFfprobeDurationSeconds(p, {}).catch(() => 12);
          }
          log(`📐 Segment coverage: ${totalSegSecs.toFixed(1)}s / ${audioDurForCombine.toFixed(1)}s audio`);

          // Fill gap by pulling more non-overlapping windows from each clip
          const needed = audioDurForCombine * 1.2;
          if (totalSegSecs < needed) {
            log(`🔁 Pulling more from existing clips (no-repeat) to fill ${(needed - totalSegSecs).toFixed(1)}s gap…`);
            let loopIdx = 0;
            let loopCounter = baseClips.length;
            let exhaustedPasses = 0;
            while (totalSegSecs < needed && exhaustedPasses < baseClips.length) {
              const clip = baseClips[loopIdx % baseClips.length];
              const clipDur = clip.duration || 30;
              const usedSoFar = clipOffsets.get(clip.localPath) || 0;
              if (usedSoFar >= clipDur - 1) {
                // This clip is fully used; if all clips exhausted, stop
                exhaustedPasses++;
                loopIdx++;
                continue;
              }
              exhaustedPasses = 0; // reset since we found a usable clip
              try {
                const segOut = await extractOne(clip, loopCounter, DEFAULT_CUT_SECS);
                if (segOut) {
                  segPaths.push(segOut);
                  totalSegSecs += await runFfprobeDurationSeconds(segOut, {}).catch(() => 12);
                  loopCounter++;
                }
              } catch (_) {}
              loopIdx++;
              if (loopIdx > 2000) break; // safety cap
            }
            log(`📐 After fill: ${totalSegSecs.toFixed(1)}s total segments (${segPaths.length} clips, no repeats)`);
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
          const { runFfmpeg } = require('./ffmpeg');
          const audioDur  = audioDurForCombine || 0;
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

          // ── Auto-captions (Groq Whisper → ASS burn) ──────────────────────
          // Enabled when job.auto_captions is true (or when caption_template is set).
          const captionTemplate = job.caption_template || (job.auto_captions ? 'explainer' : null);
          if (captionTemplate) {
            log(`🎨 Auto-captions: burning "${captionTemplate}" template…`);
            try {
              const { burnCaptions } = require('./caption-generator');
              const groqKeys = ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3']
                .map(k => process.env[k]).filter(Boolean);
              const captionedPath = path.join(OUTPUTS_DIR, `sched_captioned_${runId}.mp4`);
              await burnCaptions(muxOutPath, captionedPath, captionTemplate, groqKeys, { log, error: log });
              // Replace final output with captioned version
              fs.renameSync(captionedPath, muxOutPath);
              log(`✅ Captions burned into final video`);
            } catch (capErr) {
              log(`   ⚠️  Caption burn failed (non-fatal): ${capErr.message}`);
            }
          }

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
    clips_per_scene:       parseInt(data.clips_per_scene) || 2,
    use_youtube:           !!data.use_youtube,
    use_pexels:            data.use_pexels  !== false,
    use_pixabay:           data.use_pixabay !== false,
    podcast_host_voice:    data.podcast_host_voice  || null,
    podcast_guest_voice:   data.podcast_guest_voice || null,
    // Production preset
    auto_captions:         !!data.auto_captions,
    caption_template:      data.caption_template      || null,
    color_grade:           data.color_grade           !== false,
    title_cards:           data.title_cards           !== false,
    cut_duration_seconds:  parseFloat(data.cut_duration_seconds) || 2.5,
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
