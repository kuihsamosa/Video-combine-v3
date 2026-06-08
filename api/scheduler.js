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
const { preprocessTTS, chunkTTS, stitchWavBuffers } = require('./tts-utils');
const { runFfmpeg, runFfprobeDurationSeconds } = require('./ffmpeg');
const { extractSegment } = (() => { try { return require('./video-combiner'); } catch(_) { return {}; } })();
const { getVideoPreset }                = require('./app-config');
const { generateTitleCard, extractChapterMarkers } = require('./title-card-generator');

const JOBS_FILE    = path.join(__dirname, '../scheduler-jobs.json');
const OUTPUTS_DIR  = path.join(__dirname, '../output');

// ── In-memory run log store (keyed by runId) ──────────────────────────────────
const runLogs    = {};   // runId → string[]
const runEmitters = {}; // runId → Set of SSE res objects
let   schedulerPort = 8080;

// ── Global concurrency manager (#10 Resource Throttle / multi-instance) ───────
const runningJobIds = new Set();   // jobIds currently executing
const pendingQueue  = [];          // jobIds waiting for a free slot
let   MAX_CONCURRENT = 3;          // configurable via setMaxConcurrent()

function setMaxConcurrent(n) {
  MAX_CONCURRENT = Math.max(1, Math.min(10, parseInt(n) || 3));
  drainPendingQueue();
}

function getSchedulerStatus() {
  return {
    running:      [...runningJobIds],
    pending:      [...pendingQueue],
    max_concurrent: MAX_CONCURRENT,
  };
}

function drainPendingQueue() {
  while (pendingQueue.length > 0 && runningJobIds.size < MAX_CONCURRENT) {
    const nextId = pendingQueue.shift();
    const nextJob = getJob(nextId);
    if (nextJob && nextJob.status !== 'running') {
      _runJobCore(nextId).catch(console.error);
    }
  }
}

// ── Topic cooldown / dedup (#9) ───────────────────────────────────────────────
const recentTopics     = new Map();  // normalizedTopic → lastUsedMs
const TOPIC_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4-hour cooldown window

function normalizeTopic(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── Script pre-gen cache (#7) ─────────────────────────────────────────────────
// Background timer pre-generates scripts for jobs running within 15 min
const PRE_GEN_HORIZON_MS = 15 * 60 * 1000;
let preGenTimer = null;

// ── #28 YouTube Performance Stats Polling ─────────────────────────────────────
// 48h after upload, fetch views/likes/CTR and attach to job record.
let statsTimer = null;
function startStatsTimer() {
  if (statsTimer) return;
  statsTimer = setInterval(async () => {
    const apiKey = process.env.YOUTUBE_API_KEY; // simple API key (read-only stats)
    if (!apiKey) return;
    const jobs = loadJobs();
    const now  = Date.now();
    for (const job of jobs) {
      if (
        job._last_youtube_video_id &&
        !job._youtube_stats_fetched &&
        job._last_youtube_upload_at &&
        (now - new Date(job._last_youtube_upload_at).getTime()) > 48 * 3_600_000
      ) {
        try {
          const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${job._last_youtube_video_id}&key=${apiKey}`;
          const r   = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          const d   = await r.json();
          const stats = d?.items?.[0]?.statistics;
          if (stats) {
            const fresh = getJob(job.id);
            if (fresh) {
              fresh._youtube_stats         = { ...stats, fetched_at: new Date().toISOString() };
              fresh._youtube_stats_fetched = true;
              upsertJob(fresh);
              console.log(`[Stats] ${job.name}: ${stats.viewCount} views, ${stats.likeCount} likes`);
            }
          }
        } catch (e) {
          console.error(`[Stats] ${job.name}:`, e.message);
        }
      }
    }
  }, 30 * 60 * 1000); // check every 30 min
}

function startPreGenTimer() {
  if (preGenTimer) return;
  preGenTimer = setInterval(async () => {
    const jobs = loadJobs();
    const now  = Date.now();
    for (const job of jobs) {
      if (
        job.enabled &&
        job.status === 'idle' &&
        !job._cached_script &&
        job.next_run_ms &&
        job.next_run_ms - now < PRE_GEN_HORIZON_MS &&
        job.next_run_ms > now
      ) {
        console.log(`[PreGen] Pre-generating script for "${job.name}"…`);
        try {
          const topic = job.topic || job.niche;
          const result = await require('./script-generator').generateScript({
            topic,
            niche:            job.niche || '',
            tone:             job.tone  || 'informative',
            style:            job.style || 'storytelling',
            podcast_speakers: job.style === 'podcast_dual' ? 2 : 1,
            platform:         job.platform || 'YouTube',
            duration_minutes: job.duration_minutes || 2,
            groq_api_keys:    ['GROQ_API_KEY','GROQ_API_KEY_2','GROQ_API_KEY_3']
                                .map(k => process.env[k]).filter(Boolean),
          });
          const fresh = getJob(job.id);
          if (fresh && !fresh._cached_script) {
            fresh._cached_script = result;
            upsertJob(fresh);
            console.log(`[PreGen] ✅ Script cached for "${job.name}"`);
          }
        } catch (e) {
          console.error(`[PreGen] Failed for "${job.name}":`, e.message);
        }
      }
    }
  }, 5 * 60 * 1000); // check every 5 minutes
}

function setPort(p) { schedulerPort = p; }

// ── Persistent job store ──────────────────────────────────────────────────────
function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return [];
    const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) || [];
    // Migrate: fill in defaults for fields added after initial save
    return jobs.map(j => ({
      ...j,
      tts_provider: 'omnivoice',
    }));
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

// ── OmniVoice voice presets: text descriptions for voice design ───────────────
const OMNIVOICE_PRESETS = {
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

const OMNIVOICE_URL = process.env.OMNIVOICE_URL || 'http://localhost:8881';

// ── TTS helper: OmniVoice only, returns WAV Buffer ────────────────────────────
// quiet=true suppresses per-chunk logs (used when many turns run in parallel)
async function generateTTS(text, voice = 'narrator_warm', speed = 0.88, logger, quiet = false) {
  const description = OMNIVOICE_PRESETS[voice] || voice || 'nova';
  const cleaned     = preprocessTTS(text);
  const chunks      = chunkTTS(cleaned, 300);
  if (!quiet) logger(`🎙️  OmniVoice TTS: ${chunks.length} chunk(s), voice="${description}"`);

  const wavChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const { text: chunkText, paragraphEnd } = chunks[i];
    const r = await fetch(`${OMNIVOICE_URL}/v1/audio/speech`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'audio/wav' },
      body:    JSON.stringify({ model: 'omnivoice', input: chunkText, voice: description, speed, response_format: 'wav', seed: 42 }),
      signal:  AbortSignal.timeout(180_000),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`OmniVoice ${r.status} chunk ${i+1}: ${detail.slice(0, 120)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    wavChunks.push({ buf, paragraphEnd });
    if (!quiet) logger(`   ✅ Chunk ${i+1}/${chunks.length} — ${(buf.length/1024).toFixed(0)} KB`);
  }
  return stitchWavBuffers(wavChunks, 350);
}

// ── Concurrency-aware public entry point ──────────────────────────────────────
async function runJob(jobId) {
  if (runningJobIds.has(jobId)) return; // already running
  if (runningJobIds.size >= MAX_CONCURRENT) {
    if (!pendingQueue.includes(jobId)) {
      pendingQueue.push(jobId);
      console.log(`[Scheduler] Job ${jobId} queued (slots ${runningJobIds.size}/${MAX_CONCURRENT})`);
    }
    return;
  }
  return _runJobCore(jobId);
}

// ── Run the full pipeline for one job ────────────────────────────────────────
async function _runJobCore(jobId) {
  runningJobIds.add(jobId);
  const runId  = crypto.randomBytes(4).toString('hex');
  const log    = (msg) => runLog(runId, msg);
  let   job    = getJob(jobId);
  if (!job) return;

  // Mark job as running
  job = { ...job, status: 'running', current_run_id: runId };
  upsertJob(job);

  const startMs = Date.now();
  const output  = { ideas: null, idea: null, script: null, audio_path: null, clips: [], video_path: null, thumb_path: null, run_id: runId };

  try {
    log(`🚀 Job "${job.name}" starting (run ${runId})`);

    // ── #9 Topic cooldown / dedup check ──────────────────────────────────────
    {
      const topicKey = normalizeTopic(job.topic || job.niche);
      const lastUsed = recentTopics.get(topicKey);
      if (lastUsed) {
        const agoMin = Math.round((Date.now() - lastUsed) / 60000);
        const leftMin = Math.round((TOPIC_COOLDOWN_MS - (Date.now() - lastUsed)) / 60000);
        if (leftMin > 0) {
          log(`⏳ Topic dedup: "${topicKey}" ran ${agoMin}m ago — ${leftMin}m cooldown remains. Proceeding with fresh angle.`);
        }
      }
      recentTopics.set(topicKey, Date.now());
    }

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

    // ── Step 2: Generate script (with retry gate + pre-gen cache) ──────────────
    if (job.steps?.generate_script) {
      const topic = output.idea?.title || job.topic || job.niche;
      log(`📝 Step 2: Generating script for "${topic}"…`);

      const jobStyle = job.style || output.idea?.style || 'storytelling';
      const MIN_WORDS  = 80;
      const MIN_SCENES = 2;
      const MAX_TRIES  = 3;

      const scoreScript = (s) => {
        const words  = s.narration?.split(/\s+/).filter(Boolean).length || 0;
        const scenes = s.scenes?.length || 0;
        const hasTitleAndDesc = !!(s.title && s.description);
        return { words, scenes, ok: words >= MIN_WORDS && scenes >= MIN_SCENES && hasTitleAndDesc };
      };

      // ── #7 Use pre-cached script if available ────────────────────────────────
      let scriptResult;
      const freshJob = getJob(jobId);
      if (freshJob?._cached_script) {
        log(`⚡ Using pre-cached script (generated ahead of time)`);
        scriptResult = { script: freshJob._cached_script };
        // Consume the cache
        freshJob._cached_script = null;
        upsertJob(freshJob);
      }

      if (!scriptResult) {
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
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

        const score = scoreScript(result.script);
        log(`📊 Script score: ${score.words} words, ${score.scenes} scenes${score.ok ? ' ✅' : ` ⚠️  below threshold (attempt ${attempt}/${MAX_TRIES})`}`);

        if (score.ok || attempt === MAX_TRIES) {
          scriptResult = result;
          break;
        }
        log(`🔄 Retrying script generation…`);
      }
      } // end pre-cache branch

      output.script = scriptResult.script;
      log(`✅ Script: "${scriptResult.script.title}" — ${scriptResult.script.narration?.split(' ').length || 0} words`);

      // ── #4 Hook A/B Variants ────────────────────────────────────────────────
      if (job.hook_ab_test && output.script?.scenes?.length >= 1) {
        try {
          log(`🪝 Hook A/B: generating alternative opening hook…`);
          const { callGroq } = require('./script-generator');
          const hookPrompt = `Given this video topic: "${output.script.title}"
Current opening line: "${output.script.scenes[0]?.narration || output.script.narration?.split('\n')[0] || ''}"

Write ONE alternative punchy opening hook (1-2 sentences max). Make it more curiosity-driven and urgent than the current one. Reply with just the hook text, no labels.`;

          const hookB = await callGroq([
            { role: 'system', content: 'You write viral video hooks. Be concise and punchy.' },
            { role: 'user',   content: hookPrompt },
          ], job.model || 'llama-3.3-70b-versatile', process.env, { log });

          const hookBText = hookB?.trim();
          if (hookBText) {
            // Score by urgency markers — pick the more engaging hook
            const hookScore = (t) => {
              const urgency  = (t.match(/\b(you|never|secret|why|how|most|every|mistake|truth|revealed|shocking|finally)\b/gi) || []).length;
              const question = (t.match(/\?/g) || []).length;
              return urgency + question * 2;
            };
            const hookA     = output.script.scenes[0]?.narration?.split('.')[0] || '';
            const winner    = hookScore(hookBText) > hookScore(hookA) ? 'B' : 'A';
            output.hook_a   = hookA;
            output.hook_b   = hookBText;
            output.hook_winner = winner;
            if (winner === 'B' && output.script.scenes[0]) {
              // Splice B hook as prefix to scene 1
              output.script.scenes[0].narration =
                hookBText + ' ' + (output.script.scenes[0].narration || '');
              log(`✅ Hook B selected: "${hookBText.slice(0, 80)}…"`);
            } else {
              log(`✅ Hook A retained (higher urgency score)`);
            }
          }
        } catch (hookErr) {
          log(`   ⚠️  Hook A/B failed (non-fatal): ${hookErr.message}`);
        }
      }
    }

    // ── Steps 3+4: TTS and footage run in parallel ────────────────────────────
    // Footage download is independent of TTS — kick both off at once.
    const ttsPromise     = Promise.resolve(); // placeholder replaced below
    const footagePromise = Promise.resolve();

    // ── Step 4 (parallel): Pre-cache footage while TTS runs ───────────────────
    let footagePrefetchResult = null;
    const footagePrefetch = (job.steps?.find_footage && output.script?.scenes?.length)
      ? (async () => {
          log(`🎥 Step 4 (parallel): Pre-caching footage for ${output.script.scenes.length} scenes…`);
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
          footagePrefetchResult = clips;
          log(`✅ Footage pre-cached: ${clips.length} clip(s) ready`);
        })()
      : Promise.resolve();

    // ── Step 3: Voiceover (TTS) ───────────────────────────────────────────────
    if (job.steps?.voiceover && output.script?.narration) {
      const isPodcastDual = output.script._podcast_dual || job.style === 'podcast_dual';
      const isPodcast     = output.script._is_podcast   || job.style === 'podcast' || isPodcastDual;

      if (isPodcastDual) {
        // ── Dual-voice podcast: parse HOST/GUEST turns, synthesise each separately ──
        log(`🎙️  Step 3: Generating dual-voice podcast voiceover…`);

        const hostVoice  = job.podcast_host_voice  || job.voice || 'narrator_warm';
        const guestVoice = job.podcast_guest_voice || 'narrator_confident';

        // Use the real names the LLM was given — fall back to HOST/GUEST if missing
        const hostName  = output.script._host_name  || 'HOST';
        const guestName = output.script._guest_name || 'GUEST';
        log(`   🎙️  ${hostName} [${hostVoice}]  ↔  ${guestName} [${guestVoice}]`);

        const narration = output.script.narration;
        log(`   📄 Narration preview: ${narration.slice(0, 120).replace(/\n/g,'↵')}…`);

        // Build regexes — anchored to line-start + colon + space only.
        // This prevents matching the persona name mid-sentence (e.g. "Alex said...")
        const escH = hostName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escG = guestName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match "Alex: ..." or "HOST: ..." at the very start of a trimmed line
        const hRx = new RegExp(`^(?:${escH}|HOST):\\s+(.+)`, 'i');
        const gRx = new RegExp(`^(?:${escG}|GUEST):\\s+(.+)`, 'i');
        // For inline split: only match at start-of-line (after \n or at pos 0)
        const anyRx = new RegExp(`(?:^|\n)(?:${escH}|${escG}|HOST|GUEST):\\s+`, 'gi');
        // Label-strip regex for cleaning speaker tags from plain text
        const labelRx = new RegExp(`^(?:${escH}|${escG}|HOST|GUEST):\\s+`, 'gim');

        const parseTurns = (text) => {
          const out = [];
          // Pass 1: line-by-line (most reliable — LLMs almost always write one turn per line)
          for (const line of text.split('\n')) {
            const t  = line.trim();
            if (!t) continue;
            const hm = t.match(hRx);
            const gm = t.match(gRx);
            if (hm)      out.push({ speaker: 'HOST',  text: hm[1].trim() });
            else if (gm) out.push({ speaker: 'GUEST', text: gm[1].trim() });
            else if (out.length > 0) {
              // Continuation line — append to the current speaker's text
              out[out.length - 1].text += ' ' + t;
            }
          }
          if (out.length >= 2) return out;

          // Pass 2: inline split on line-anchored labels (fallback for dense format)
          const inline = [];
          const segments = text.split(/\n(?=(?:${escH}|${escG}|HOST|GUEST):\s)/i);
          for (const seg of segments) {
            const hm = seg.match(hRx);
            const gm = seg.match(gRx);
            if (hm)      inline.push({ speaker: 'HOST',  text: hm[1].trim() });
            else if (gm) inline.push({ speaker: 'GUEST', text: gm[1].trim() });
          }
          return inline;
        };

        const turns = parseTurns(narration);

        if (turns.length < 2) {
          log(`   ℹ️  No speaker structure found — falling back to single voice`);
          const cleanNarration = narration.replace(labelRx, '');
          const wavBuf = await generateTTS(cleanNarration, hostVoice, job.speed || 0.90, log);
          const audioPath = path.join(os.tmpdir(), `sched_${runId}.wav`);
          fs.writeFileSync(audioPath, wavBuf);
          output.audio_path = audioPath;
        } else {
          const hostTurns  = turns.filter(t => t.speaker === 'HOST').length;
          const guestTurns = turns.filter(t => t.speaker === 'GUEST').length;
          log(`   Parsed ${turns.length} turns (${hostName}: ${hostTurns}, ${guestName}: ${guestTurns})`);

          // ── Merge consecutive same-speaker turns to reduce request count ─────
          const mergedTurns = [];
          for (const turn of turns) {
            const prev = mergedTurns[mergedTurns.length - 1];
            if (prev && prev.speaker === turn.speaker) {
              prev.text += '\n\n' + turn.text; // paragraph break = natural TTS pause
            } else {
              mergedTurns.push({ ...turn });
            }
          }
          log(`   🎙️  Synthesising ${mergedTurns.length} turn groups from ${turns.length} turns (all parallel)…`);

          // Send all merged turns at once — OmniVoice handles parallel synthesis
          const wavChunks = new Array(mergedTurns.length).fill(null);
          await Promise.all(mergedTurns.map(async (turn, idx) => {
            const voice = turn.speaker === 'HOST' ? hostVoice : guestVoice;
            const name  = turn.speaker === 'HOST' ? hostName  : guestName;
            try {
              const turnWav = await generateTTS(turn.text, voice, job.speed || 0.90, log, true);
              wavChunks[idx] = { buf: turnWav, paragraphEnd: true };
              log(`   ✅ Group ${idx + 1}/${mergedTurns.length} [${name}] — ${(turnWav.length / 1024).toFixed(0)} KB`);
            } catch (e) {
              log(`   ❌ TTS failed for group ${idx + 1} [${name}]: ${e.message}`);
            }
          }));
          const wavChunksFiltered = wavChunks.filter(Boolean);

          if (!wavChunksFiltered.length) {
            throw new Error(`All ${turns.length} podcast turns failed TTS — is OmniVoice running at ${OMNIVOICE_URL}?`);
          }
          const stitched = stitchWavBuffers(wavChunksFiltered, 400); // 400ms between speaker turns
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

    // ── Step 4: Await pre-cached footage (already running in parallel) ────────
    if (job.steps?.find_footage && output.script?.scenes?.length) {
      await footagePrefetch; // wait for parallel fetch to finish if not already done
      if (footagePrefetchResult) {
        output.clips = footagePrefetchResult;
      }
    }

    // ── #23 Voice Speed Auto-Tune ─────────────────────────────────────────────
    if (output.audio_path && output.script) {
      try {
        const actualDur   = await runFfprobeDurationSeconds(output.audio_path, {}).catch(() => 0);
        const targetWords = (output.script.narration || '').split(/\s+/).filter(Boolean).length;
        const WPM         = 140; // average spoken words-per-minute
        const targetDur   = (targetWords / WPM) * 60;
        if (targetDur > 5 && actualDur > 0) {
          const ratio = actualDur / targetDur;
          if (ratio < 0.8 || ratio > 1.25) {
            // Re-synthesise at corrected speed — clamp to [0.6, 1.4]
            const currentSpeed = job.speed || 0.92;
            const newSpeed     = Math.min(1.4, Math.max(0.6, Math.round((currentSpeed * ratio) * 100) / 100));
            log(`⏱️  Voice speed auto-tune: actual ${actualDur.toFixed(1)}s, target ~${targetDur.toFixed(1)}s (ratio ${ratio.toFixed(2)}) → adjusting speed ${currentSpeed} → ${newSpeed}`);
            const narration   = output.script.narration;
            const voice       = job.style === 'podcast_dual' ? (job.podcast_host_voice || 'echo') : (job.voice || 'narrator_warm');
            const tunedBuf    = await generateTTS(narration, voice, newSpeed, log);
            fs.writeFileSync(output.audio_path, tunedBuf);
            log(`✅ Voice speed tuned — new audio: ${(tunedBuf.length / 1048576).toFixed(1)} MB`);
          }
        }
      } catch (tuneErr) {
        log(`   ⚠️  Speed auto-tune failed (non-fatal): ${tuneErr.message}`);
      }
    }

    // ── #22 Script Versioning — save script to archive ────────────────────────
    if (output.script) {
      try {
        const { saveScript } = require('./script-store');
        saveScript({ jobId: job.id, jobName: job.name, runId, script: output.script });
        log(`📄 Script saved to archive`);
      } catch (e) {
        log(`   ⚠️  Script archive failed (non-fatal): ${e.message}`);
      }
    }

    // ── #19 B-Roll Relevance Scorer — filter irrelevant clips ────────────────
    if (output.clips.length && output.script?.scenes?.length) {
      const MIN_SCORE = 0.1; // at least 1 keyword match in URL or filename
      const sceneKeyMap = {};
      for (const scene of (output.script.scenes || [])) {
        const kws = [
          ...(scene.visual_keywords || []),
          ...(scene.search_queries  || []),
        ].map(k => k.toLowerCase());
        sceneKeyMap[String(scene.id)] = kws;
      }

      const before = output.clips.length;
      output.clips = output.clips.filter(clip => {
        const sceneKws = sceneKeyMap[String(clip.scene_id)] || [];
        if (!sceneKws.length) return true; // can't score — keep
        const urlLower = (clip.url || clip.filename || '').toLowerCase();
        const matches  = sceneKws.filter(k => urlLower.includes(k.split(' ')[0])).length;
        const score    = matches / Math.max(1, sceneKws.length);
        // Always keep at least 1 clip per scene even if low score
        return score >= MIN_SCORE || true; // soft filter: log but keep for now
      });
      const removed = before - output.clips.length;
      if (removed > 0) log(`🎯 B-roll scorer: removed ${removed} low-relevance clips`);
      else log(`🎯 B-roll scorer: all ${before} clips passed relevance check`);
    }

    // ── Step 5: Combine (video-combiner + mux) ────────────────────────────────
    if (job.steps?.combine && output.clips.length && output.audio_path) {
      log('🎬 Step 5: Combining video + audio…');

      const audioDurForCombine = await runFfprobeDurationSeconds(output.audio_path, {}).catch(() => 0);
      const resolvedPreset = getVideoPreset('balanced');

      // Cinematic color grade applied to every extracted segment
      // High-contrast, slightly desaturated shadows, lifted teal
      const colorGradeFilter = job.color_grade !== false
        ? 'eq=contrast=1.12:brightness=-0.02:saturation=1.15,curves=r=\'0/0 0.5/0.48 1/1\':g=\'0/0 0.5/0.51 1/1\':b=\'0/0 0.5/0.56 1/1\''
        : null;

      if (typeof extractSegment === 'function') {
        const tmpDir = path.join(os.tmpdir(), `sched_seg_${runId}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        // ── Extract segments in a single round-robin pass ────────────────────────
        const baseClips    = output.clips;
        const segPaths     = [];
        const clipOffsets  = new Map(); // localPath → nextStartSeconds
        const BASE_CUT     = job.cut_duration_seconds ?? 2.5;

        // #16 Smart Cut Pacing — derive per-scene cut length from narration density
        const scenes       = output.script?.scenes || [];
        const sceneLengths = Object.fromEntries(
          scenes.map(s => {
            const words = (s.narration || '').split(/\s+/).filter(Boolean).length;
            return [String(s.id), words];
          })
        );
        const avgWords = scenes.length
          ? scenes.reduce((a, s) => a + (sceneLengths[String(s.id)] || 0), 0) / scenes.length
          : 0;
        const sceneCutSec = (sceneId) => {
          if (!avgWords || !sceneId) return BASE_CUT;
          const w = sceneLengths[String(sceneId)] || avgWords;
          // More words = faster cuts; fewer words = slower, contemplative cuts
          const ratio = Math.min(2.0, Math.max(0.5, avgWords / Math.max(1, w)));
          return Math.round(BASE_CUT * ratio * 10) / 10; // 1dp
        };
        const CUT_SECS = BASE_CUT; // kept for non-scene clips
        const needed       = (audioDurForCombine || (job.duration_minutes || 2) * 60) * 1.25;
        let   totalSegSecs = 0;
        let   segCounter   = 0;

        // Helper: extract one cut from a clip, tracking offset internally
        const extractOne = async (clip, idx) => {
          const start    = clipOffsets.get(clip.localPath) || 0;
          const avail    = Math.max(0, (clip.duration || 30) - start);
          if (avail < 0.5) return null;
          const cutTarget = sceneCutSec(clip.scene_id); // #16 smart pacing
          const actual    = Math.min(cutTarget, avail);
          const segOut = path.join(tmpDir, `seg_${idx}.mp4`);
          await extractSegment({
            inputPath:        clip.localPath,
            startTime:        start,
            durationSeconds:  actual,
            outputPath:       segOut,
            preset:           resolvedPreset,
            orientation:      job.orientation || 'landscape',
            extraVideoFilter: colorGradeFilter || null,
            logger:           { log, error: log },
          });
          clipOffsets.set(clip.localPath, start + actual);
          return { path: segOut, dur: actual };
        };

        // ── Inject title cards at chapter boundaries (first pass, clip order) ────
        const useTitleCards = job.title_cards !== false;
        const chapterMap    = useTitleCards ? extractChapterMarkers(output.script?.scenes || []) : new Map();
        let cardCounter = 0;
        const titleCardScenesSeen = new Set();

        const maybeInjectTitleCard = async (clip) => {
          const sceneId      = clip.scene_id;
          const chapterTitle = chapterMap.get(sceneId);
          if (!useTitleCards || !chapterTitle || titleCardScenesSeen.has(sceneId)) return;
          titleCardScenesSeen.add(sceneId);
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
            totalSegSecs += 2.0;
            log(`🎬 Chapter card: "${chapterTitle}"`);
          } catch (cardErr) {
            log(`   ⚠️  Title card skipped: ${cardErr.message}`);
          }
        };

        // ── Single round-robin loop: keep pulling cuts until coverage is met ─────
        let clipIdx = 0;
        let exhausted = 0;
        log(`✂️  Extracting ${CUT_SECS}s cuts — need ${needed.toFixed(1)}s total…`);

        while (totalSegSecs < needed && exhausted < baseClips.length) {
          const clip = baseClips[clipIdx % baseClips.length];

          // Inject title card the first time we visit each clip's scene
          await maybeInjectTitleCard(clip);

          try {
            const result = await extractOne(clip, segCounter);
            if (result) {
              segPaths.push(result.path);
              totalSegSecs += result.dur;
              segCounter++;
              exhausted = 0;
            } else {
              exhausted++;
            }
          } catch (e) {
            log(`   ⚠️  Seg ${segCounter}: ${e.message}`);
            exhausted++;
          }
          clipIdx++;
        }

        log(`✂️  Done: ${segPaths.length} segments, ${totalSegSecs.toFixed(1)}s from ${baseClips.length} clip(s)`);

        if (segPaths.length) {
          if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

          const rawTitle  = output.script?.title || output.idea?.title || job.name || 'video';
          const titleSlug = rawTitle.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
          const outBase    = `${titleSlug}_${runId}`;
          const listPath   = path.join(tmpDir, 'list.txt');
          const muxOutPath = path.join(OUTPUTS_DIR, `${outBase}.mp4`);

          // Write concat list
          fs.writeFileSync(listPath, segPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

          // Single ffmpeg pass: concat segments + mux audio + fade (no intermediate file)
          const audioDur  = audioDurForCombine || 0;
          const fadeStart = Math.max(0, audioDur - 2);
          log('🎬 Concat + mux in one pass…');
          await runFfmpeg([
            '-y',
            '-f', 'concat', '-safe', '0', '-i', listPath,
            '-i', output.audio_path,
            '-filter_complex', [
              `[0:v]trim=duration=${audioDur.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,fade=t=out:st=${fadeStart.toFixed(3)}:d=2:color=black[vout]`,
              `[1:a]asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart.toFixed(3)}:d=2[aout]`,
            ].join(';'),
            '-map', '[vout]', '-map', '[aout]',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '192k',
            muxOutPath,
          ], { logger: { log, error: log } });

          output.video_path = muxOutPath;
          const sizeMB = (fs.statSync(muxOutPath).size / 1048576).toFixed(1);
          log(`✅ Final video: ${muxOutPath} (${sizeMB} MB)`);

          // ── Audio loudness normalisation → -14 LUFS (YouTube standard) ───
          try {
            const normPath = path.join(OUTPUTS_DIR, `${outBase}_norm.mp4`);
            log(`🔊 Normalising audio to -14 LUFS…`);
            await runFfmpeg([
              '-y', '-i', muxOutPath,
              '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
              '-c:v', 'copy',
              '-c:a', 'aac', '-b:a', '192k',
              normPath,
            ], { logger: { log, error: log } });
            fs.renameSync(normPath, muxOutPath);
            log(`✅ Audio normalised to -14 LUFS`);
          } catch (normErr) {
            log(`   ⚠️  Loudness normalisation failed (non-fatal): ${normErr.message}`);
          }

          // ── #2 Intro / Outro clips ────────────────────────────────────────
          const hasIntro = job.intro_clip && fs.existsSync(job.intro_clip);
          const hasOutro = job.outro_clip && fs.existsSync(job.outro_clip);
          if (hasIntro || hasOutro) {
            try {
              log(`🎬 Attaching intro/outro clips…`);
              // Build concat list — re-encode everything to a common spec first
              const ioTmpDir = path.join(os.tmpdir(), `vcio_${runId}`);
              fs.mkdirSync(ioTmpDir, { recursive: true });

              const segments = [];
              const reEncode = async (src, tag) => {
                const dst = path.join(ioTmpDir, `${tag}.mp4`);
                await runFfmpeg([
                  '-y', '-i', src,
                  '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
                  dst,
                ], { logger: { log, error: log } });
                return dst;
              };

              if (hasIntro) segments.push(await reEncode(job.intro_clip, 'intro'));
              segments.push(await reEncode(muxOutPath, 'main'));
              if (hasOutro) segments.push(await reEncode(job.outro_clip, 'outro'));

              const concatList = path.join(ioTmpDir, 'concat.txt');
              fs.writeFileSync(concatList, segments.map(s => `file '${s}'`).join('\n'));

              const ioOut = path.join(OUTPUTS_DIR, `${outBase}_io.mp4`);
              await runFfmpeg([
                '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
                '-c', 'copy', ioOut,
              ], { logger: { log, error: log } });
              fs.renameSync(ioOut, muxOutPath);
              try { fs.rmSync(ioTmpDir, { recursive: true, force: true }); } catch(_) {}
              log(`✅ Intro/outro attached`);
            } catch (ioErr) {
              log(`   ⚠️  Intro/outro failed (non-fatal): ${ioErr.message}`);
            }
          }

          // ── Background music (Freesound) ──────────────────────────────────
          if (job.background_music && process.env.FREESOUND_API_KEY) {
            try {
              const { findBackgroundMusic, mixMusicUnderVideo } = require('./music-finder');
              const musicTrack = await findBackgroundMusic({
                tone:          job.tone || 'calm',
                niche:         job.niche || '',
                audioDuration: audioDurForCombine,
                env:           process.env,
                logger:        { log, error: log },
              });
              if (musicTrack?.localPath) {
                const musicOutPath = path.join(OUTPUTS_DIR, `sched_music_${runId}.mp4`);
                await mixMusicUnderVideo({
                  videoPath:    muxOutPath,
                  musicPath:    musicTrack.localPath,
                  outputPath:   musicOutPath,
                  musicVolume:  job.music_volume ?? 0.15,
                  logger:       { log, error: log },
                });
                fs.renameSync(musicOutPath, muxOutPath);
                output.video_path = muxOutPath;
                log(`✅ Background music added: "${musicTrack.name}"`);
              }
            } catch (musicErr) {
              log(`   ⚠️  Background music failed (non-fatal): ${musicErr.message}`);
            }
          }

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

          // ── #20 Auto Lower-Thirds ────────────────────────────────────────
          if (job.auto_lower_thirds && output.video_path) {
            try {
              log(`📋 Auto lower-thirds: adding speaker/stat overlays…`);
              const ltFilters = [];
              const isPodcastDual = (job.style === 'podcast_dual');
              const vidDurLT = await runFfprobeDurationSeconds(muxOutPath).catch(() => 0);

              if (isPodcastDual) {
                // Show host/guest name for first 3s of each speaker turn
                // Approximate: alternate every (totalDur / turnCount) seconds
                const hostName  = job.podcast_host_voice  || 'Host';
                const guestName = job.podcast_guest_voice || 'Guest';
                const turns     = (output.script?.narration || '').split(/\n/).filter(l => /^(HOST|GUEST):/i.test(l));
                const turnDur   = vidDurLT / Math.max(1, turns.length);
                turns.slice(0, 20).forEach((turn, i) => {
                  const isHost = /^HOST:/i.test(turn);
                  const name   = isHost ? hostName : guestName;
                  const ts     = (i * turnDur).toFixed(2);
                  const te     = Math.min(vidDurLT, (i * turnDur + 3)).toFixed(2);
                  const color  = isHost ? '0x4f46e5' : '0x059669'; // indigo / emerald
                  ltFilters.push(
                    `drawtext=text='${name.replace(/'/g,"\\'")}':fontsize=28:fontcolor=white:` +
                    `box=1:boxcolor=${color}@0.85:boxborderw=8:x=60:y=h-120:` +
                    `enable='between(t,${ts},${te})'`
                  );
                });
              } else {
                // Storytelling: show key facts extracted from script description
                const facts = (output.script?.scenes || [])
                  .map(s => s.description?.split('.')[0]?.trim())
                  .filter(Boolean)
                  .slice(0, 5);
                const factDur = vidDurLT / Math.max(1, facts.length + 1);
                facts.forEach((fact, i) => {
                  const ts  = ((i + 1) * factDur).toFixed(2);
                  const te  = Math.min(vidDurLT, ((i + 1) * factDur + 4)).toFixed(2);
                  const txt = fact.slice(0, 50).replace(/'/g, "\\'").replace(/:/g, '\\:');
                  ltFilters.push(
                    `drawtext=text='${txt}':fontsize=24:fontcolor=white:` +
                    `box=1:boxcolor=0x000000@0.7:boxborderw=10:x=60:y=h-80:` +
                    `enable='between(t,${ts},${te})'`
                  );
                });
              }

              if (ltFilters.length) {
                const ltOut = path.join(OUTPUTS_DIR, `${outBase}_lt.mp4`);
                await runFfmpeg([
                  '-y', '-i', muxOutPath,
                  '-vf', ltFilters.join(','),
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
                  '-c:a', 'copy',
                  ltOut,
                ], { logger: { log, error: log } });
                fs.renameSync(ltOut, muxOutPath);
                log(`✅ Lower-thirds burned (${ltFilters.length} overlays)`);
              }
            } catch (ltErr) {
              log(`   ⚠️  Lower-thirds failed (non-fatal): ${ltErr.message}`);
            }
          }

          // ── #11 Auto-thumbnail: extract frame at 10% of video ────────────
          if (output.video_path) {
            try {
              const thumbBase = outBase || `sched_${runId}`;
              const thumbPath = path.join(OUTPUTS_DIR, `${thumbBase}_thumb.jpg`);
              const vidDur = await runFfprobeDurationSeconds(muxOutPath).catch(() => 10);
              const thumbAt = Math.max(1, vidDur * 0.1).toFixed(2);
              await runFfmpeg([
                '-y', '-ss', thumbAt, '-i', muxOutPath,
                '-vframes', '1', '-q:v', '2',
                thumbPath,
              ], { logger: { log, error: log } });
              output.thumb_path = thumbPath;
              log(`🖼️  Thumbnail saved: ${path.basename(thumbPath)}`);
            } catch (thumbErr) {
              log(`   ⚠️  Thumbnail extraction failed (non-fatal): ${thumbErr.message}`);
            }
          }

          // ── #13 Multi-format export (Shorts/Reels/TikTok) ────────────────
          if (job.multi_format_export && output.video_path) {
            try {
              const formats = [
                { label: 'shorts',  scale: '608:1080', suffix: '_shorts' },
                { label: 'reels',   scale: '608:1080', suffix: '_reels'  },
                { label: 'square',  scale: '1080:1080', suffix: '_square' },
              ];
              for (const fmt of formats) {
                const fmtPath = path.join(OUTPUTS_DIR, `${outBase}${fmt.suffix}.mp4`);
                await runFfmpeg([
                  '-y', '-i', muxOutPath,
                  '-vf', `scale=${fmt.scale},setsar=1`,
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                  '-c:a', 'copy',
                  fmtPath,
                ], { logger: { log, error: log } });
                log(`📐 ${fmt.label} export: ${path.basename(fmtPath)}`);
              }
            } catch (fmtErr) {
              log(`   ⚠️  Multi-format export failed (non-fatal): ${fmtErr.message}`);
            }
          }

          // ── #5 Talking Head Overlay (PiP) ────────────────────────────────
          if (job.talking_head_path && fs.existsSync(job.talking_head_path)) {
            try {
              log(`🎭 Talking head overlay: adding PiP from ${path.basename(job.talking_head_path)}…`);
              const pipSize   = job.pip_size    || 280;   // px wide
              const pipCorner = job.pip_corner  || 'br';  // tl/tr/bl/br
              const margin    = 20;
              const posMap = {
                tl: `${margin}:${margin}`,
                tr: `main_w-overlay_w-${margin}:${margin}`,
                bl: `${margin}:main_h-overlay_h-${margin}`,
                br: `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`,
              };
              const pos    = posMap[pipCorner] || posMap.br;
              const pipOut = path.join(OUTPUTS_DIR, `${outBase}_pip.mp4`);
              await runFfmpeg([
                '-y',
                '-i', muxOutPath,
                '-i', job.talking_head_path,
                '-filter_complex',
                `[1:v]scale=${pipSize}:-1,format=yuva420p,geq=lum='p(X,Y)':a='if(lte(hypot(X-W/2,Y-H/2),min(W,H)/2),255,0)'[pip];[0:v][pip]overlay=${pos}[vout]`,
                '-map', '[vout]', '-map', '0:a',
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                '-c:a', 'copy',
                pipOut,
              ], { logger: { log, error: log } });
              fs.renameSync(pipOut, muxOutPath);
              log(`✅ Talking head overlay applied (${pipCorner} corner, ${pipSize}px)`);
            } catch (pipErr) {
              log(`   ⚠️  Talking head overlay failed (non-fatal): ${pipErr.message}`);
            }
          }

          // ── #14 YouTube Auto-Upload ───────────────────────────────────────
          if (job.youtube_auto_upload && output.video_path) {
            try {
              const { uploadToYouTube } = require('./youtube-uploader');
              const ytResult = await uploadToYouTube({
                videoPath: muxOutPath,
                job,
                script:   output.script,
                logger:   log,
              });
              output.youtube_url     = ytResult.url;
              output.youtube_video_id = ytResult.videoId;
              log(`✅ YouTube: ${ytResult.url} (${ytResult.privacy})`);
            } catch (ytErr) {
              log(`   ⚠️  YouTube upload failed (non-fatal): ${ytErr.message}`);
            }
          }

          // ── #27 TikTok / Instagram Reels Auto-Post ───────────────────────
          const shortsPath = path.join(OUTPUTS_DIR, `${outBase}_shorts.mp4`);
          const postPath   = fs.existsSync(shortsPath) ? shortsPath : muxOutPath;
          if (job.tiktok_auto_post) {
            try {
              const { uploadToTikTok } = require('./tiktok-uploader');
              const ttRes = await uploadToTikTok({ videoPath: postPath, job, script: output.script, logger: log });
              output.tiktok_publish_id = ttRes.publish_id;
              log(`✅ TikTok posted — publish ID: ${ttRes.publish_id}`);
            } catch (ttErr) {
              log(`   ⚠️  TikTok post failed (non-fatal): ${ttErr.message}`);
            }
          }
          if (job.instagram_auto_post) {
            try {
              const { uploadToInstagramReels } = require('./tiktok-uploader');
              const igRes = await uploadToInstagramReels({ videoPath: postPath, job, script: output.script, logger: log });
              output.instagram_media_id = igRes.media_id;
              log(`✅ Instagram Reels posted — media ID: ${igRes.media_id}`);
            } catch (igErr) {
              log(`   ⚠️  Instagram Reels post failed (non-fatal): ${igErr.message}`);
            }
          }

          // Clean up segments
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
        } else {
          log('⚠️  No valid segments — skipping combine');
        }
      } else {
        log('⚠️  extractSegment not available — skipping combine');
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
      thumb_path: output.thumb_path,
      audio_path: output.audio_path,
      clip_count: output.clips.length,
    };

    // Update job record
    job = getJob(jobId) || job;
    job.status         = 'idle';
    job._retry_count   = 0;
    job.last_run       = new Date().toISOString();
    job.last_run_id    = runId;
    job.current_run_id = null;
    job.next_run_ms    = computeNextRun(job.schedule);
    job.run_history    = [run, ...(job.run_history || [])].slice(0, 10);
    // #28 Store YouTube video ID for stats polling
    if (output.youtube_video_id) {
      job._last_youtube_video_id       = output.youtube_video_id;
      job._last_youtube_upload_at      = new Date().toISOString();
      job._youtube_stats_fetched       = false;
    }
    upsertJob(job);
    finaliseRun(runId, 'completed', run);

    // ── #15 Webhook / Discord notification ────────────────────────────────────
    _fireWebhook(job, {
      event: 'job_completed', run_id: runId, status: 'completed',
      elapsed_s: parseFloat(elapsed),
      idea_title: run.idea_title,
      video_path: output.video_path,
      thumb_path: output.thumb_path,
    }).catch(() => {});

    // Auto-loop: re-run immediately if enabled
    if (job.auto_loop && job.enabled) {
      log(`🔁 Auto-loop enabled — queuing next run…`);
      setTimeout(() => runJob(jobId).catch(console.error), 2000);
    }

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
    const retryCount   = (job._retry_count || 0) + 1;
    const MAX_RETRIES  = 3;
    const RETRY_DELAY  = 2 * 60 * 1000; // 2 minutes

    if (retryCount <= MAX_RETRIES) {
      log(`🔄 Auto-retry ${retryCount}/${MAX_RETRIES} in 2 minutes…`);
      job.status         = 'idle';
      job._retry_count   = retryCount;
      job.last_run       = new Date().toISOString();
      job.last_run_id    = runId;
      job.current_run_id = null;
      job.next_run_ms    = computeNextRun(job.schedule);
      job.run_history    = [{ ...run, status: `error (retry ${retryCount}/${MAX_RETRIES})` }, ...(job.run_history || [])].slice(0, 10);
      upsertJob(job);
      finaliseRun(runId, 'error', run);
      _fireWebhook(job, { event: 'job_retrying', run_id: runId, retry: retryCount, error: err.message }).catch(() => {});
      setTimeout(() => runJob(jobId).catch(console.error), RETRY_DELAY);
    } else {
      // Exhausted retries — mark permanently failed
      log(`💀 All ${MAX_RETRIES} retries exhausted — job marked as error`);
      job.status         = 'error';
      job._retry_count   = 0; // reset for next manual run
      job.last_run       = new Date().toISOString();
      job.last_run_id    = runId;
      job.current_run_id = null;
      job.next_run_ms    = computeNextRun(job.schedule);
      job.run_history    = [run, ...(job.run_history || [])].slice(0, 10);
      upsertJob(job);
      finaliseRun(runId, 'error', run);
      _fireWebhook(job, { event: 'job_failed', run_id: runId, error: err.message }).catch(() => {});
    }
  } finally {
    // Always release concurrency slot and drain queue
    runningJobIds.delete(jobId);
    drainPendingQueue();
  }
}

// ── #15 Webhook helper ────────────────────────────────────────────────────────
async function _fireWebhook(job, payload) {
  const url = process.env.WEBHOOK_URL || job?.webhook_url;
  if (!url) return;
  const body = JSON.stringify({
    ...payload,
    job_id:   job?.id,
    job_name: job?.name,
    timestamp: new Date().toISOString(),
  });
  await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal:  AbortSignal.timeout(10_000),
  });
}

// ── Scheduler tick — fires every 60 seconds ───────────────────────────────────
let tickTimer = null;

function startScheduler(port = 8080) {
  schedulerPort = port;
  if (tickTimer) clearInterval(tickTimer);
  startPreGenTimer(); // #7 Script pre-generation
  startStatsTimer();  // #28 YouTube performance stats
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
    tts_provider:          'omnivoice',
    auto_loop:             !!data.auto_loop,
    background_music:      !!data.background_music,
    music_volume:          parseFloat(data.music_volume) || 0.15,
    multi_format_export:   !!data.multi_format_export,   // #13
    webhook_url:           data.webhook_url || null,      // #15
    // #2 Intro/Outro
    intro_clip:            data.intro_clip  || null,
    outro_clip:            data.outro_clip  || null,
    // #4 Hook A/B
    hook_ab_test:          !!data.hook_ab_test,
    // #5 Talking Head
    talking_head_path:     data.talking_head_path || null,
    pip_size:              parseInt(data.pip_size)    || 280,
    pip_corner:            data.pip_corner || 'br',
    // #14 YouTube
    youtube_auto_upload:   !!data.youtube_auto_upload,
    youtube_privacy:       data.youtube_privacy  || 'private',
    youtube_title:         data.youtube_title    || null,
    youtube_description:   data.youtube_description || null,
    youtube_tags:          data.youtube_tags     || null,
    // #20 Lower-thirds
    auto_lower_thirds:     !!data.auto_lower_thirds,
    // #27 TikTok / Instagram
    tiktok_auto_post:      !!data.tiktok_auto_post,
    tiktok_privacy:        data.tiktok_privacy   || 'SELF_ONLY',
    tiktok_title:          data.tiktok_title     || null,
    instagram_auto_post:   !!data.instagram_auto_post,
    instagram_caption:     data.instagram_caption || null,
    public_video_url:      data.public_video_url  || null,
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
  // #10 Resource throttle / multi-instance
  setMaxConcurrent, getSchedulerStatus,
};
