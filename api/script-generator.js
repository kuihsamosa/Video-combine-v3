// Script generator — Groq only (multi-key rotation), extended schema with YouTube metadata.

// Node 16 compatibility: polyfill global fetch with built-in https if needed
if (typeof fetch === 'undefined') {
  const https = require('https');
  const http  = require('http');
  global.fetch = function nodeFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const body = opts.body ? Buffer.from(opts.body) : null;
      const req = mod.request({
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname + u.search,
        method:   opts.method || 'GET',
        headers:  Object.assign({ ...(opts.headers || {}) }, body ? { 'content-length': body.length } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok:     res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            text:   async () => buf.toString(),
            json:   async () => JSON.parse(buf.toString()),
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Groq models ───────────────────────────────────────────────────────────────
const GROQ_MODELS = [
  { id: 'llama-3.3-70b-versatile',  label: 'Llama 3.3 70B (best quality)' },
  { id: 'llama-3.1-8b-instant',     label: 'Llama 3.1 8B (fastest)'       },
  { id: 'llama3-70b-8192',          label: 'Llama 3 70B (8K context)'      },
  { id: 'mixtral-8x7b-32768',       label: 'Mixtral 8x7B (32K context)'    },
];

// ── Groq key rotation ─────────────────────────────────────────────────────────
let _keyIndex = 0;

function getGroqKeys(env) {
  return ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3']
    .map(k => env[k])
    .filter(Boolean);
}

// ── Prompts ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a scriptwriter for high-retention faceless YouTube channels. Your scripts do NOT sound like educational content. They sound like a sharp, opinionated person who has thought deeply about a topic and is making a case — with evidence, counter-arguments, and real intellectual friction.

CRITICAL: Respond with ONLY a valid JSON object. No markdown fences, no explanation, no text outside the JSON.

Required schema:
{
  "title": "Provocative, opinion-forward title (6-10 words) — sounds like a take, not a tutorial",
  "description": "The core argument in 1-2 sentences — what claim this video makes and why it matters",
  "narration": "THE FULL SPOKEN SCRIPT — see rules below",
  "scenes": [
    {
      "id": 1,
      "duration_hint_seconds": 10,
      "visual_keywords": ["specific keyword", "medium keyword", "broad keyword", "fallback keyword", "generic keyword"],
      "search_queries": ["specific 2-3 word stock query", "medium 1-2 word query", "single broad word"],
      "description": "What should be on screen during this segment",
      "on_screen_text": "Key stat or claim to flash on screen — max 6 words, e.g. '78% never recover' or 'The system is designed this way' — empty string if nothing strong fits",
      "chapter_title": "ALL-CAPS chapter heading when a new argument begins, e.g. 'THE REAL REASON' or 'WHY EVERYONE GETS THIS WRONG' — empty string for mid-argument scenes"
    }
  ],
  "youtube": {
    "title": "SEO title (max 60 chars, lead with the argument or provocative claim)",
    "description": "Full YouTube description (150-300 words). Open with the core argument. Build the case in 2-3 paragraphs. End with a question that invites debate.",
    "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10"],
    "hashtags": ["Hashtag1","Hashtag2","Hashtag3","Hashtag4","Hashtag5"],
    "category": "Education"
  }
}

════════════════════════════════════════
SCENE KEYWORD RULES — CRITICAL FOR FOOTAGE
════════════════════════════════════════

visual_keywords: Exactly 5 UNIQUE keywords per scene — no keyword may repeat across scenes.
  Ordered from MOST SPECIFIC to MOST GENERIC:
  - keyword 1: specific action + subject (e.g. "elderly man running park")
  - keyword 2: action or subject alone (e.g. "morning jog outdoor")
  - keyword 3: topic category (e.g. "fitness over 50")
  - keyword 4: broad emotion/concept (e.g. "determination perseverance")
  - keyword 5: universal cinematic fallback (e.g. "nature sunrise")
  RULES:
  - Every keyword must be a real stock-footage search term that returns results on Pexels/Pixabay.
  - No proper nouns, brand names, or abstract words (e.g. avoid "resilience", "mindset").
  - Each scene must have DIFFERENT keywords — varied subjects, not the same topic rephrased.
  - Think visually: what does a camera operator actually film? People doing things, environments, close-ups.

search_queries: Exactly 3 UNIQUE pre-built search strings per scene — no query may repeat across scenes.
  - query 1: 2-3 descriptive words (e.g. "senior man exercising outdoors")
  - query 2: 1-2 action words (e.g. "running trail")
  - query 3: 1 broad noun fallback (e.g. "fitness")
  Each query must be meaningfully different from other scenes' queries — use synonyms, locations, shot types.

on_screen_text: Short visual overlay — a stat, a claim, or a provocative phrase.
  - Examples: "78% of people", "$2,160/year", "This is by design", "Most experts are wrong"
  - Max 6 words. Empty string "" if nothing strong fits.

chapter_title: ALL-CAPS title card for when a new main argument begins.
  - Examples: "THE REAL REASON", "WHY THIS KEEPS HAPPENING", "WHAT THEY DON'T TELL YOU"
  - Only on the FIRST scene of a new argument — empty string "" everywhere else.
  - A 2-minute video: 3-5 chapter cards maximum.

════════════════════════════════════════
OPENING — THE FIRST 15 SECONDS
════════════════════════════════════════

Start with the argument, not a question. Make a bold, specific claim that will stop someone mid-scroll.

STRONG openings (study these):
  "Nobody actually earns their way to wealth. They stumble into a system that rewards accumulation, and then they call it discipline. And that distinction matters more than almost anything else in personal finance."
  "The reason most diets fail has nothing to do with willpower. It never did. It's that we've been treating a behavioral problem like a calorie problem — and the entire industry depends on you never figuring that out."
  "Most startup advice is written by people who got lucky and then worked backwards to explain it. That's not cynicism. That's what the data actually shows when you look at which founders succeed and which don't."

WEAK openings (never write these):
  "Have you ever wondered why..." — passive, no claim
  "Today we're going to talk about..." — announcement, not argument
  "Welcome back, in this video..." — kills retention instantly
  "There are five things you need to know about..." — listicle energy, not argument

The opening must make a claim the viewer can agree with, disagree with, or be surprised by. Neutral is death.

════════════════════════════════════════
NARRATION STRUCTURE
════════════════════════════════════════

Think of this as a SPOKEN ARGUMENT, not a list of tips. Structure:

  1. OPENING CLAIM (first 15s): One or two sentences that make the core argument immediately. Bold, specific, slightly uncomfortable. No setup. No greeting. Just the point.

  2. THE COMPLICATION (15-40s): Acknowledge the obvious counter-argument or the conventional wisdom — then dismantle it. "Most people assume X. And on the surface that makes sense. But here's where that breaks down..."

  3. THE DEEP DIVE (body): Go below the surface. Explain the mechanism — WHY this is true, HOW it actually works, WHAT most people miss. Each layer should go deeper than the last:
       - Layer 1: What people think is happening
       - Layer 2: What is actually happening
       - Layer 3: What that means at a systems level or over time
     Use specific numbers, real examples, and cause-and-effect chains — not just assertions.
     Every 3-4 sentences, land on one short sentence that crystallises the point. Then keep going.

  4. THE TURN: A moment where the argument deepens — "But here is the part that nobody talks about..." or "And this is where it gets genuinely interesting..." — keeps engaged viewers watching.

  5. WHAT TO DO WITH THIS: Do not give a listicle of tips. Give one or two honest, specific, non-obvious things the viewer can act on — and explain WHY they work given everything you have just argued.

  6. CLOSE: Return to the opening claim. Restate it — but now the viewer has the full context to understand it differently. No hollow CTA. One genuine question that leaves them thinking: "So the real question is not X. It is Y."

════════════════════════════════════════
ARGUMENTATION RULES — NON-NEGOTIABLE
════════════════════════════════════════

  - Every main point needs EVIDENCE: a number, a study result, a named example, or a tight logical chain. Assertions without evidence are filler.
  - STEELMAN the opposing view before you demolish it. Acknowledging complexity makes the argument stronger, not weaker.
  - Go specific over general. "Most people" is weak. "A Stanford study of 2,000 participants found that 71%..." is strong. If you lack a real stat, build a concrete illustrative scenario with actual numbers.
  - Name the mechanism. Don't just say something is true — explain WHY it is true. Causation over correlation. Systems over symptoms.
  - Use friction deliberately. Something counterintuitive or against conventional wisdom is not a problem — it is the point. The viewer should feel slightly challenged.

════════════════════════════════════════
VOICE AND STYLE
════════════════════════════════════════

  - Tone: Like the smartest person in the room who does not need to prove it — direct, confident, occasionally blunt
  - Contractions always: "you're", "it's", "that's", "don't", "won't", "here's", "we've"
  - Speak to "you" — never "people", "viewers", or "society"
  - Vary sentence length aggressively. Short works. So does a longer sentence that builds and builds and does not resolve until the very end, landing the idea with weight.
  - Rhetorical questions only when they carry genuine tension — not as a crutch. One every 5-6 sentences maximum.
  - BANNED (instant fail): "In this video", "Let's dive in", "Today I want to talk about", "Furthermore", "In conclusion", "Additionally", "It is important to note", "Welcome back", "Without further ado", "As we can see"
  - ZERO stage directions: no [pause], (beat), [music], [cut to] — only the spoken words

PACING:
  - 150 words per minute when read aloud naturally
  - After every cluster of 3-4 dense sentences: one short standalone sentence. It resets the listener.
  - Never three long sentences in a row without a break

GREAT NARRATION EXAMPLE:
  "The productivity advice industry has a dirty secret. Most of it is designed to keep you optimising rather than shipping. Think about it — if you actually became productive, you'd stop buying productivity tools and books. The entire market depends on you staying stuck in a slightly better version of stuck. The research backs this up: people who spend the most time on personal organisation systems are statistically less likely to complete long-term goals than people who just start. Not because systems are bad. Because optimising the system becomes the work. So here is the uncomfortable question: what are you organising instead of doing?"`;

function buildUserPrompt({ topic, niche, tone, duration_minutes, style }) {
  const words = Math.round(duration_minutes * 150);
  return [
    `Topic: ${topic}`,
    `Niche: ${niche || 'general'}`,
    `Tone: ${tone || 'conversational'}`,
    `Style: ${style || 'storytelling'}`,
    `Target duration: ${duration_minutes} minute${duration_minutes !== 1 ? 's' : ''} (~${words} spoken words)`,
    ``,
    `Write the narration as ~${words} words of natural spoken prose following ALL the rules above.`,
    `Scenes should map to ~${Math.round(duration_minutes * 60)} seconds total.`,
    ``,
    `Output JSON only. No markdown. No explanation.`,
  ].join('\n');
}

// ── JSON extraction ───────────────────────────────────────────────────────────
function extractJson(text) {
  const stripped = text.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Model response was not valid JSON');
}

// ── Groq call with key rotation ───────────────────────────────────────────────
async function callGroq(messages, model, env, logger) {
  const keys = getGroqKeys(env);
  if (!keys.length) throw new Error('No GROQ_API_KEY configured in .env');

  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(_keyIndex + i) % keys.length];
    try {
      logger.log(`🤖 Groq [key ${i + 1}/${keys.length}] ${model}`);
      const r = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0.85, max_tokens: 4096 }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => r.statusText);
        const e = new Error(`Groq ${r.status}: ${txt.slice(0, 200)}`);
        e.status = r.status;
        throw e;
      }
      const data = await r.json();
      _keyIndex = (_keyIndex + i + 1) % keys.length;
      return {
        content:  data.choices?.[0]?.message?.content ?? '',
        tokens:   data.usage?.total_tokens ?? 0,
        provider: 'groq',
        model,
      };
    } catch (err) {
      lastErr = err;
      if (err.status === 429) {
        logger.log(`   ⚠️  Groq key ${i + 1} rate-limited — trying next…`);
        continue;
      }
      throw err;
    }
  }
  // All keys exhausted — signal caller to try next provider
  const e = new Error('All Groq keys exhausted (rate-limited)');
  e.status = 429;
  throw e;
}

// ── Gemini call ───────────────────────────────────────────────────────────────
// Free tier: generous daily quota. Tries models from newest to lightest.
async function callGemini(messages, env, logger) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  // Convert OpenAI-style messages to Gemini format
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const userMsgs  = messages.filter(m => m.role !== 'system');
  const contents  = userMsgs.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  if (systemMsg && contents[0]?.role === 'user') {
    contents[0].parts[0].text = `${systemMsg}\n\n${contents[0].parts[0].text}`;
  }

  // Try models in order — newest first, lighter fallbacks if overloaded
  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-flash-lite-latest'];
  let lastGeminiErr;
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    logger.log(`🤖 Gemini [${model}] (Groq fallback)`);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: { temperature: 0.85, maxOutputTokens: 4096 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => r.statusText);
        const e = new Error(`Gemini ${r.status}: ${txt.slice(0, 200)}`);
        e.status = r.status;
        throw e;
      }
      const data    = await r.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const tokens  = (data.usageMetadata?.promptTokenCount ?? 0) + (data.usageMetadata?.candidatesTokenCount ?? 0);
      return { content, tokens, provider: 'gemini', model };
    } catch (e) {
      lastGeminiErr = e;
      if (e.status === 503 || e.status === 429 || e.status === 500) {
        logger.log(`   ⚠️  Gemini ${model} unavailable (${e.status}) — trying next model…`);
        continue;
      }
      throw e; // auth error etc — don't retry other models
    }
  }
  // All Gemini models overloaded — signal caller to try next provider
  const e = new Error(`All Gemini models overloaded: ${lastGeminiErr?.message}`);
  e.status = 503;
  throw e;
}

// ── OpenRouter call ───────────────────────────────────────────────────────────
// Routes to many models; free models available (e.g. mistral-7b-instruct:free).
async function callOpenRouter(messages, env, logger) {
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not configured');

  // Prefer a capable free model; fall back to a paid one
  const model = 'mistralai/mistral-7b-instruct:free';
  logger.log(`🤖 OpenRouter [${model}] (Groq+Gemini fallback)`);

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer':  'https://video-combine.local',
      'X-Title':       'Video Combine Scheduler',
    },
    body: JSON.stringify({ model, messages, temperature: 0.85, max_tokens: 4096 }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => r.statusText);
    const e = new Error(`OpenRouter ${r.status}: ${txt.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }

  const data = await r.json();
  return {
    content:  data.choices?.[0]?.message?.content ?? '',
    tokens:   data.usage?.total_tokens ?? 0,
    provider: 'openrouter',
    model,
  };
}

// ── Mistral direct call ───────────────────────────────────────────────────────
async function callMistral(messages, env, logger) {
  const key = env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not configured');

  const model = 'mistral-small-latest'; // cheapest capable Mistral model
  logger.log(`🤖 Mistral [${model}] (last resort fallback)`);

  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.85, max_tokens: 4096 }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => r.statusText);
    const e = new Error(`Mistral ${r.status}: ${txt.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }

  const data = await r.json();
  return {
    content:  data.choices?.[0]?.message?.content ?? '',
    tokens:   data.usage?.total_tokens ?? 0,
    provider: 'mistral',
    model,
  };
}

// ── Multi-provider call with automatic fallback ───────────────────────────────
// Order: Groq (round-robin keys) → Gemini → OpenRouter → Mistral
// Each provider is only tried if its key is configured.
async function callLLM(messages, model, env, logger) {
  const providers = [
    // 1. Groq — preferred (fast, generous free tier)
    getGroqKeys(env).length > 0
      ? () => callGroq(messages, model, env, logger)
      : null,
    // 2. Gemini — free daily quota, good quality
    env.GEMINI_API_KEY
      ? () => callGemini(messages, env, logger)
      : null,
    // 3. OpenRouter — has free models
    env.OPENROUTER_API_KEY
      ? () => callOpenRouter(messages, env, logger)
      : null,
    // 4. Mistral — paid but cheap, last resort
    env.MISTRAL_API_KEY
      ? () => callMistral(messages, env, logger)
      : null,
  ].filter(Boolean);

  if (!providers.length) throw new Error('No LLM provider configured. Add GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or MISTRAL_API_KEY to .env');

  let lastErr;
  for (const tryProvider of providers) {
    try {
      return await tryProvider();
    } catch (err) {
      lastErr = err;
      if (err.status === 429 || err.status === 503 || /rate.limit|quota|exhausted/i.test(err.message)) {
        logger.log(`   ⚠️  Provider exhausted — trying next fallback…`);
        continue;
      }
      throw err; // non-rate-limit error — propagate immediately
    }
  }
  throw new Error(`All LLM providers exhausted. Last error: ${lastErr?.message}`);
}

// ── Main export ───────────────────────────────────────────────────────────────
async function generateScript(params, logger) {
  const {
    topic,
    niche            = 'general',
    tone             = 'conversational',
    duration_minutes = 2,
    style            = 'storytelling',
    podcast_speakers = 1,
    model            = 'llama-3.3-70b-versatile',
    env              = process.env,
  } = params;

  if (!topic?.trim()) throw new Error('topic is required');

  const isPodcast    = style === 'podcast' || style === 'podcast_dual';
  const speakers     = style === 'podcast_dual' ? 2 : (podcast_speakers || 1);
  // Pick random names for this run so speakers sound like real people, not labels
  const [hostName, guestName] = randomNamePair();
  const systemPrompt = isPodcast ? PODCAST_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const userPrompt   = isPodcast
    ? buildPodcastPrompt({ topic, niche, tone, duration_minutes, podcast_speakers: speakers, host_name: hostName, guest_name: guestName })
    : buildUserPrompt({ topic, niche, tone, duration_minutes, style });

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt },
  ];

  let result = await callLLM(messages, model, env, logger);
  logger.log(`📝 Response: ${result.content.length} chars, ${result.tokens} tokens [${result.provider}/${result.model}]`);

  let script;
  try {
    script = extractJson(result.content);
  } catch (_) {
    logger.log('⚠️  JSON parse failed — retrying with correction…');
    const retry = await callLLM([
      ...messages,
      { role: 'assistant', content: result.content },
      { role: 'user', content: 'Your response was not valid JSON. Output ONLY the raw JSON object — no markdown, no explanation.' },
    ], model, env, logger);
    script = extractJson(retry.content);
    result.tokens += retry.tokens;
  }

  if (!script.narration?.trim()) throw new Error('Generated script missing narration field');
  if (!script.scenes?.length)    throw new Error('Generated script missing scenes array');

  if (isPodcast) {
    script._is_podcast   = true;
    script._speakers     = speakers;
    script._podcast_dual = speakers >= 2;
    script._host_name    = hostName;
    script._guest_name   = guestName;
  }

  logger.log(`✅ Script: "${script.title}" — ${script.narration.split(/\s+/).length} words, ${script.scenes.length} scenes${isPodcast ? ` [podcast${speakers >= 2 ? ` dual: ${hostName} + ${guestName}` : ` mono: ${hostName}`}]` : ''}`);
  return { script, model_used: `${result.provider}/${result.model}`, tokens_used: result.tokens, is_podcast: isPodcast, podcast_speakers: speakers };
}

function availableModels(env = process.env) {
  const models = [];
  if (getGroqKeys(env).length > 0)  models.push(...GROQ_MODELS.map(m => ({ model: m.id, label: m.label, provider: 'groq' })));
  if (env.GEMINI_API_KEY)            models.push({ model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (free)', provider: 'gemini' });
  if (env.OPENROUTER_API_KEY)        models.push({ model: 'mistralai/mistral-7b-instruct:free', label: 'Mistral 7B via OpenRouter (free)', provider: 'openrouter' });
  if (env.MISTRAL_API_KEY)           models.push({ model: 'mistral-small-latest', label: 'Mistral Small', provider: 'mistral' });
  return models;
}


// ── Podcast system prompt ─────────────────────────────────────────────────────
const PODCAST_SYSTEM_PROMPT = `You are an expert podcast scriptwriter who creates compelling, natural-sounding podcast episodes for faceless video channels.
Podcast scripts feel like a real recorded conversation — warm, exploratory, and unscripted in energy, even though every word is written.

CRITICAL: Respond with ONLY a valid JSON object. No markdown fences, no explanation, no text outside the JSON.

Required schema:
{
  "title": "Podcast episode title (conversational, 5-8 words, with episode feel)",
  "description": "What this episode covers in 1-2 sentences",
  "narration": "THE FULL PODCAST SCRIPT — see format rules below",
  "speakers": ["HOST", "GUEST"],
  "scenes": [
    {
      "id": 1,
      "duration_hint_seconds": 45,
      "visual_keywords": ["specific keyword", "medium keyword", "broad keyword", "fallback keyword", "generic keyword"],
      "search_queries": ["specific 2-3 word stock query", "medium 1-2 word query", "single broad word"],
      "description": "What should be on screen — use contemplative imagery, text overlays, relevant B-roll",
      "on_screen_text": "Key quote or stat from this segment, max 8 words — or empty string",
      "chapter_title": "Chapter heading if new topic starts here — or empty string"
    }
  ],
  "youtube": {
    "title": "SEO YouTube title (max 60 chars)",
    "description": "Full YouTube description (150-300 words). Mention it is a podcast-style deep dive.",
    "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10"],
    "hashtags": ["Hashtag1","Hashtag2","Hashtag3","Hashtag4","Hashtag5"],
    "category": "Education"
  }
}

════════════════════════════════════════
PODCAST SCRIPT FORMAT — CRITICAL
════════════════════════════════════════

For SINGLE-HOST podcast (monologue):
  - Write as one continuous HOST monologue. No labels needed.
  - Tone: personal, reflective, like a friend sharing deep thoughts over coffee
  - Longer sentences allowed. More philosophical. Slower pacing (~130 wpm).
  - Use "I" and "we" liberally. Share opinions and personal perspective.
  - Natural filler that adds texture: "you know...", "and honestly,", "here is the thing though,", "I keep coming back to this idea that"
  - No hard "hook formula" — open with a personal observation or story, not a question
  - Paragraphs should be 4-6 sentences (vs 2-3 in short-form video)
  - Outro: personal sign-off, not a CTA-heavy push. "That is all I have got for today. Take care of yourself out there."

For DUAL-HOST podcast (conversation):
  - Format EVERY line as: HOST: [dialogue] or GUEST: [dialogue]
  - No other text outside these labels. Every sentence must have a speaker prefix.
  - HOST opens and closes the episode. GUEST is the expert being interviewed.
  - Conversation feels natural: interruptions are OK ("HOST: Right, exactly —"), short affirmations ("GUEST: Yeah, absolutely."), building on each other
  - HOST asks probing questions, challenges gently, summarises key points
  - GUEST gives detailed expert answers, anecdotes, and concrete examples
  - Average turn length: 2-4 sentences. Vary it — some one-liners, some longer monologues.
  - Include at least 3 moments where they genuinely disagree or add nuance to each other

════════════════════════════════════════
PODCAST SCENE RULES
════════════════════════════════════════

Scenes are longer (30-60s each) because podcast pacing is slower.
Visuals should be contemplative and thematic — not action-packed B-roll.
Good visual choices for podcast: aerial city shots, people thinking/walking, abstract textures,
coffee shop atmosphere, nature landscapes, slow close-ups of hands/objects.

visual_keywords and search_queries: follow the same uniqueness rules as standard videos — every scene must have DIFFERENT keywords and queries. No keyword or query may repeat across scenes.
on_screen_text: use memorable quotes from the script ("The system is designed to keep you spending"),
  statistics, or provocative questions — these are the main visual interest for a podcast video.

════════════════════════════════════════
WHAT GREAT PODCAST NARRATION SOUNDS LIKE
════════════════════════════════════════

Single host example:
  "I have been thinking about this for weeks now. There is a question that keeps nagging at me — why is it that the people who seem to have the most, often feel like they have the least? And I do not mean that in a motivational-poster kind of way. I mean it literally. I have watched people build something real, hit every marker of success they ever dreamed of, and then wake up one Tuesday morning feeling completely hollow. And nobody talks about that part. So today, I want to go there."

Dual host example:
  HOST: Okay so I want to start with something that actually surprised me when I was researching this.
  GUEST: Yeah, go for it.
  HOST: The data shows that most people make their worst financial decisions not when they are broke — but right after their first big raise. Like that is when the wheels come off.
  GUEST: That tracks completely. There is actually a name for it — lifestyle inflation. And it is sneaky because it does not feel like a mistake when it is happening. It feels like reward.
  HOST: Right, like you have earned it.
  GUEST: Exactly. And nobody is going to tell you to stop. Your friends are excited for you. Your family is proud. The whole world is saying yes.`;

// ── Random name pairs for podcast speakers ───────────────────────────────────
// Real first names so the LLM writes "Alex: ..." instead of "HOST: ..."
// Picked at random each run so the channel feels like a real show.
const PODCAST_NAME_PAIRS = [
  ['Alex',    'Jordan'],
  ['Sam',     'Taylor'],
  ['Morgan',  'Riley'],
  ['Casey',   'Drew'],
  ['Jamie',   'Quinn'],
  ['Ryan',    'Avery'],
  ['Blake',   'Skylar'],
  ['Charlie', 'Reese'],
  ['Mia',     'Ethan'],
  ['Lena',    'Marcus'],
];

function randomNamePair() {
  return PODCAST_NAME_PAIRS[Math.floor(Math.random() * PODCAST_NAME_PAIRS.length)];
}

// ── Podcast user prompt builder ───────────────────────────────────────────────
function buildPodcastPrompt({ topic, niche, tone, duration_minutes, podcast_speakers = 1, host_name, guest_name }) {
  const words      = Math.round(duration_minutes * 130);
  const scenesCount = Math.ceil((duration_minutes * 60) / 45);
  const isDual     = podcast_speakers >= 2;
  const format     = isDual ? `DUAL-HOST conversation between ${host_name} and ${guest_name}` : 'SINGLE-HOST (monologue)';

  return [
    `Topic: ${topic}`,
    `Niche: ${niche || 'general'}`,
    `Tone: ${tone || 'conversational'}`,
    `Format: ${format}`,
    `Target duration: ${duration_minutes} minute${duration_minutes !== 1 ? 's' : ''} (~${words} spoken words)`,
    `Scenes: approximately ${scenesCount} scenes (one per ~45 seconds)`,
    ``,
    isDual
      ? `Write the narration as a full conversation (~${words} total words).
CRITICAL: Every single line MUST start with "${host_name}:" or "${guest_name}:" — no other format, no exceptions.
${host_name} is the host who drives the conversation, asks questions, and challenges ideas.
${guest_name} is the expert guest who gives detailed answers, anecdotes, and evidence.
They refer to each other by name naturally (e.g. "${host_name} turns to ${guest_name}..." or "${guest_name}, what do you make of that?").
The conversation should feel genuinely exploratory and unscripted in energy.`
      : `Write the narration as a single-host monologue spoken by ${host_name} (~${words} words).
Personal, reflective, deep — not a listicle. ${host_name} speaks directly to the listener.`,
    ``,
    `Output JSON only. No markdown. No explanation.`,
  ].join('\n');
}

module.exports = { generateScript, availableModels, GROQ_MODELS, PODCAST_SYSTEM_PROMPT, callGroq };
