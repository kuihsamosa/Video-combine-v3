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
const SYSTEM_PROMPT = `You are a top-tier YouTube scriptwriter who specialises in faceless video channels that consistently hit millions of views.
Your scripts sound like a real human being talking — not an essay, not a listicle, not a press release.
They are warm, direct, and keep the viewer glued from the first word to the last.

CRITICAL: Respond with ONLY a valid JSON object. No markdown fences, no explanation, no text outside the JSON.

Required schema:
{
  "title": "Attention-grabbing video title (6-10 words, creates curiosity or promises value)",
  "description": "1-2 sentence hook — what the viewer will walk away knowing",
  "narration": "THE FULL SPOKEN VOICEOVER SCRIPT — see rules below",
  "scenes": [
    {
      "id": 1,
      "duration_hint_seconds": 10,
      "visual_keywords": ["specific keyword", "medium keyword", "broad keyword", "fallback keyword", "generic keyword"],
      "search_queries": ["specific 2-3 word stock query", "medium 1-2 word query", "single broad word"],
      "description": "What should be on screen during this segment"
    }
  ],
  "youtube": {
    "title": "SEO YouTube title (max 60 chars, lead with main keyword)",
    "description": "Full YouTube description (150-300 words). Open with a hook sentence. Then 2-3 body paragraphs. End with CTA to subscribe and comment. Naturally embed keywords.",
    "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10"],
    "hashtags": ["Hashtag1","Hashtag2","Hashtag3","Hashtag4","Hashtag5"],
    "category": "Education"
  }
}

════════════════════════════════════════
SCENE KEYWORD RULES — CRITICAL FOR FOOTAGE
════════════════════════════════════════

visual_keywords: Exactly 5 keywords, ordered from MOST SPECIFIC to MOST GENERIC.
  - keyword 1: specific action/subject (e.g. "person doing push-ups")
  - keyword 2: medium specificity (e.g. "gym workout")
  - keyword 3: topic-level (e.g. "fitness exercise")
  - keyword 4: broad category (e.g. "sport health")
  - keyword 5: universal fallback (e.g. "motivation success")
  Rules: ALL keywords must be real stock-footage search terms that return results on Pexels/Pixabay.
  AVOID overly niche phrases, proper nouns, brand names, or abstract concepts that have no visual.

search_queries: Exactly 3 pre-built search strings for Pexels/Pixabay, from specific to broad:
  - query 1: 2-3 words, most specific (e.g. "gym weight training")
  - query 2: 1-2 words, medium (e.g. "fitness workout")
  - query 3: 1 single common word, broadest fallback (e.g. "exercise")

════════════════════════════════════════
NARRATION WRITING RULES — READ CAREFULLY
════════════════════════════════════════

STRUCTURE (follow this arc every time):
  1. HOOK (first 5-10 seconds): One punchy line that stops the scroll. A bold claim, a shocking stat, or a question they can't ignore. NO greetings yet.
  2. PROMISE: Tell them what they're about to learn / why it matters. One or two sentences.
  3. GREETING: "Welcome back, everyone" or "Hey, welcome in" — warm but brief.
  4. BODY: The actual content delivered as a flowing conversation. Break big ideas into short punchy sections. Use rhetorical questions to keep them engaged ("But here's the thing — why does this even matter?"). Pause with a short sentence for emphasis. Build tension then release it.
  5. CALLBACK + PAYOFF: Tie back to the hook. Deliver on the promise.
  6. OUTRO + CTA: "If this hit different for you, drop a like — it seriously helps. Subscribe if you want more of this. And I'll see you in the next one."

VOICE AND STYLE:
  - Write exactly how a smart, enthusiastic friend would explain this over coffee — not a Wikipedia article
  - Use contractions everywhere: "you're", "it's", "that's", "here's", "we're", "don't"
  - Use second-person: speak directly to "you" and "we"
  - Mix sentence lengths: one short punchy sentence. Then a longer one that builds context and carries the listener forward. Then short again.
  - Use natural spoken filler only when it adds rhythm: "And honestly?", "Here's the thing.", "Think about it.", "Right?", "Seriously."
  - Rhetorical questions: ask the listener something they can't help but answer in their head
  - Avoid: bullet-point energy, "In this video we will discuss", "Furthermore", "In conclusion", "Additionally", "It is important to note"
  - Avoid any stage directions like [pause], (beat), [cut to], etc. — just the spoken words

PACING:
  - ~150 words per minute when spoken naturally
  - Every 3-4 sentences: a moment of emphasis (one short powerful sentence alone)
  - Vary rhythm to prevent monotony

WHAT GREAT NARRATION SOUNDS LIKE:
  "Nobody talks about this. But it changes everything once you see it. [GREETING] Hey, welcome in — I'm glad you're here. Because today we're going to break down one of the most misunderstood forces in modern life..."`;

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
        content: data.choices?.[0]?.message?.content ?? '',
        tokens:  data.usage?.total_tokens ?? 0,
      };
    } catch (err) {
      lastErr = err;
      if (err.status === 429) {
        logger.log(`   ⚠️  Key ${i + 1} rate-limited — trying next…`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function generateScript(params, logger) {
  const {
    topic,
    niche          = 'general',
    tone           = 'conversational',
    duration_minutes = 2,
    style          = 'storytelling',
    model          = 'llama-3.3-70b-versatile',
    env            = process.env,
  } = params;

  if (!topic?.trim()) throw new Error('topic is required');

  const userPrompt = buildUserPrompt({ topic, niche, tone, duration_minutes, style });
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userPrompt },
  ];

  let result = await callGroq(messages, model, env, logger);
  logger.log(`📝 Response: ${result.content.length} chars, ${result.tokens} tokens`);

  let script;
  try {
    script = extractJson(result.content);
  } catch (_) {
    logger.log('⚠️  JSON parse failed — retrying with correction…');
    const retry = await callGroq([
      ...messages,
      { role: 'assistant', content: result.content },
      { role: 'user', content: 'Your response was not valid JSON. Output ONLY the raw JSON object — no markdown, no explanation.' },
    ], model, env, logger);
    script = extractJson(retry.content);
    result.tokens += retry.tokens;
  }

  if (!script.narration?.trim()) throw new Error('Generated script missing narration field');
  if (!script.scenes?.length)    throw new Error('Generated script missing scenes array');

  logger.log(`✅ Script: "${script.title}" — ${script.narration.split(/\s+/).length} words, ${script.scenes.length} scenes`);
  return { script, model_used: model, tokens_used: result.tokens };
}

function availableModels(env = process.env) {
  const hasKey = getGroqKeys(env).length > 0;
  if (!hasKey) return [];
  return GROQ_MODELS.map(m => ({ model: m.id, label: m.label, provider: 'groq' }));
}

module.exports = { generateScript, availableModels, GROQ_MODELS };
