// Script generator — Groq only (multi-key rotation), extended schema with YouTube metadata.

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
const SYSTEM_PROMPT = `You are a professional scriptwriter and YouTube SEO expert for faceless video channels.
Given a topic, niche, tone, style, and target duration, produce a complete video package.

CRITICAL: Respond with ONLY a valid JSON object. No markdown fences, no explanation, no text outside the JSON.

Required schema (fill every field):
{
  "title": "Compelling video title, 5-10 words",
  "description": "1-2 sentence summary of the video",
  "narration": "Full voiceover script as continuous spoken prose (~150 words/min). No stage directions, no scene markers — just the words spoken aloud.",
  "scenes": [
    {
      "id": 1,
      "duration_hint_seconds": 10,
      "visual_keywords": ["keyword1", "keyword2", "keyword3"],
      "description": "What should visually appear on screen during this segment"
    }
  ],
  "youtube": {
    "title": "SEO-optimised YouTube title (max 60 chars, include main keyword near start)",
    "description": "Full YouTube video description (150-300 words). Start with a hook. Include: what viewers will learn, 2-3 paragraph body, call-to-action (subscribe/comment), and relevant links placeholder. Naturally embed keywords.",
    "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10"],
    "hashtags": ["Hashtag1", "Hashtag2", "Hashtag3", "Hashtag4", "Hashtag5"],
    "category": "Education"
  }
}

Rules:
- narration must be fluent, engaging continuous prose — absolutely no bullet points or headers
- scenes should cover 4-12 logical visual segments
- visual_keywords per scene: 3-5 concrete searchable nouns/adjectives for stock footage (e.g. "mountain sunrise", "city traffic", "person meditating")
- duration_hint_seconds should sum close to total target duration
- youtube.tags: 8-12 short phrases, mix broad and specific, no # symbol
- youtube.hashtags: 3-5 title-case words with no spaces, no # symbol`;

function buildUserPrompt({ topic, niche, tone, duration_minutes, style }) {
  const words = Math.round(duration_minutes * 150);
  return [
    `Topic: ${topic}`,
    `Niche: ${niche || 'general'}`,
    `Tone: ${tone || 'educational'}`,
    `Style: ${style || 'storytelling'}`,
    `Target duration: ${duration_minutes} minute${duration_minutes !== 1 ? 's' : ''} (~${words} words)`,
    '',
    'Output JSON only.',
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
        body: JSON.stringify({ model, messages, temperature: 0.8, max_tokens: 4096 }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => r.statusText);
        const e = new Error(`Groq ${r.status}: ${txt.slice(0, 200)}`);
        e.status = r.status;
        throw e;
      }
      const data = await r.json();
      _keyIndex = (_keyIndex + i + 1) % keys.length;   // advance past this key
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
/**
 * Generate a complete structured video script via Groq.
 *
 * @param {object} params
 * @param {string} params.topic
 * @param {string} [params.niche]
 * @param {string} [params.tone]
 * @param {number} [params.duration_minutes=2]
 * @param {string} [params.style]
 * @param {string} [params.model='llama-3.3-70b-versatile']
 * @param {object} [params.env]   — defaults to process.env
 * @param {object} logger
 * @returns {Promise<{ script, model_used, tokens_used }>}
 */
async function generateScript(params, logger) {
  const {
    topic,
    niche          = 'general',
    tone           = 'educational',
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

/** Returns Groq model list (always available when any GROQ key is set). */
function availableModels(env = process.env) {
  const hasKey = getGroqKeys(env).length > 0;
  if (!hasKey) return [];
  return GROQ_MODELS.map(m => ({ model: m.id, label: m.label, provider: 'groq' }));
}

module.exports = { generateScript, availableModels, GROQ_MODELS };
