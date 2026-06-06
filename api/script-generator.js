// Script generator for faceless video automation
// Supports: Groq (with multi-key rotation), Google Gemini, Mistral, OpenRouter
// Uses native fetch (Node 18+) — no npm packages required.

// ── Provider definitions ──────────────────────────────────────────────────────

const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'llama3-70b-8192',
    ],
    envKeys: ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3'],
    format: 'openai',
  },
  gemini: {
    // Uses the generateContent REST API (v1beta)
    url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    models: [
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ],
    envKeys: ['GEMINI_API_KEY'],
    format: 'gemini',
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    models: [
      'mistral-large-latest',
      'mistral-small-latest',
      'open-mixtral-8x22b',
    ],
    envKeys: ['MISTRAL_API_KEY'],
    format: 'openai',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    models: [
      'openai/gpt-4o',
      'anthropic/claude-3.5-sonnet',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-001',
      'mistralai/mistral-large',
    ],
    envKeys: ['OPENROUTER_API_KEY'],
    format: 'openai',
  },
};

// ── Groq key rotation ─────────────────────────────────────────────────────────
// Cycles through GROQ_API_KEY → GROQ_API_KEY_2 → GROQ_API_KEY_3 on rate-limit
// errors (429). Falls back to next key; raises after all are exhausted.

let _groqKeyIndex = 0;
function nextGroqKey(env) {
  const keys = PROVIDERS.groq.envKeys
    .map(k => env[k])
    .filter(Boolean);
  if (!keys.length) return null;
  const key = keys[_groqKeyIndex % keys.length];
  _groqKeyIndex = (_groqKeyIndex + 1) % keys.length;
  return key;
}

// ── System / user prompts ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a professional scriptwriter for faceless YouTube and TikTok videos.
Given a topic, niche, tone, style, and target duration, produce a complete video script.

CRITICAL: Respond with ONLY a valid JSON object — no markdown fences, no explanations, no text before or after.

The JSON must follow this exact schema:
{
  "title": "Compelling video title (5-10 words)",
  "description": "1-2 sentence video description for YouTube/social",
  "narration": "Full voiceover script as natural spoken prose. Write exactly as it should be read aloud — no stage directions, no scene markers, just the words the narrator speaks. Target ~150 words per minute.",
  "scenes": [
    {
      "id": 1,
      "duration_hint_seconds": 10,
      "visual_keywords": ["keyword1", "keyword2", "keyword3"],
      "description": "What should appear on screen during this moment"
    }
  ],
  "hashtags": ["hashtag1", "hashtag2", "hashtag3", "hashtag4", "hashtag5"]
}

Rules:
- narration must be continuous, fluent, engaging prose — no bullet points, no headers
- scenes array should divide the video into logical visual segments (4-12 scenes typical)
- visual_keywords are concrete nouns/adjectives useful for searching stock footage
- duration_hint_seconds across all scenes should sum close to the target duration
- hashtags should be relevant, trending, and without the # symbol`;

function buildUserPrompt({ topic, niche, tone, duration_minutes, style }) {
  const words = Math.round(duration_minutes * 150);
  return [
    `Topic: ${topic}`,
    `Niche: ${niche || 'general'}`,
    `Tone: ${tone || 'informative'}`,
    `Style: ${style || 'storytelling'}`,
    `Target duration: ${duration_minutes} minute${duration_minutes !== 1 ? 's' : ''} (~${words} words of narration)`,
    '',
    'Write the complete script now. Output JSON only.',
  ].join('\n');
}

// ── JSON extraction ───────────────────────────────────────────────────────────

function extractJson(text) {
  const stripped = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
  try { return JSON.parse(stripped); } catch (_) {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('Model response was not valid JSON');
}

// ── OpenAI-compatible call (Groq / Mistral / OpenRouter) ─────────────────────

async function callOpenAI(url, messages, model, apiKey, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ model, messages, temperature: 0.8, max_tokens: 4096 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    const e = new Error(`API error ${res.status}: ${err}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    tokens: data.usage?.total_tokens ?? 0,
  };
}

// ── Gemini call ───────────────────────────────────────────────────────────────

async function callGemini(model, systemPrompt, userPrompt, apiKey) {
  const url = PROVIDERS.gemini.url.replace('{model}', model) + `?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    const e = new Error(`Gemini error ${res.status}: ${err}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const tokens = (data.usageMetadata?.promptTokenCount ?? 0) + (data.usageMetadata?.candidatesTokenCount ?? 0);
  return { content, tokens };
}

// ── Provider router ───────────────────────────────────────────────────────────

function resolveProvider(model) {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.models.includes(model)) return name;
  }
  // Heuristic fallbacks
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('mistral') || model.startsWith('open-mixtral')) return 'mistral';
  if (model.includes('/')) return 'openrouter';
  return 'groq';
}

async function callProvider(provider, model, messages, userPrompt, env, logger) {
  const p = PROVIDERS[provider];

  if (provider === 'groq') {
    // Try each key in rotation; retry once on 429
    const keys = p.envKeys.map(k => env[k]).filter(Boolean);
    if (!keys.length) throw new Error('No GROQ_API_KEY configured');
    let lastErr;
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[(_groqKeyIndex + attempt) % keys.length];
      try {
        logger.log(`🤖 Groq [key ${attempt + 1}/${keys.length}] model: ${model}`);
        const result = await callOpenAI(p.url, messages, model, key);
        _groqKeyIndex = (_groqKeyIndex + attempt + 1) % keys.length; // advance past used key
        return result;
      } catch (err) {
        lastErr = err;
        if (err.status === 429) {
          logger.log(`⚠️  Groq key ${attempt + 1} rate-limited — trying next key…`);
          continue;
        }
        throw err; // non-rate-limit errors → rethrow immediately
      }
    }
    throw lastErr;
  }

  if (provider === 'gemini') {
    const key = env[p.envKeys[0]];
    if (!key) throw new Error('GEMINI_API_KEY not configured');
    logger.log(`🤖 Gemini model: ${model}`);
    return callGemini(model, SYSTEM_PROMPT, userPrompt, key);
  }

  if (provider === 'mistral') {
    const key = env[p.envKeys[0]];
    if (!key) throw new Error('MISTRAL_API_KEY not configured');
    logger.log(`🤖 Mistral model: ${model}`);
    return callOpenAI(p.url, messages, model, key);
  }

  if (provider === 'openrouter') {
    const key = env[p.envKeys[0]];
    if (!key) throw new Error('OPENROUTER_API_KEY not configured');
    logger.log(`🤖 OpenRouter model: ${model}`);
    return callOpenAI(p.url, messages, model, key, {
      'HTTP-Referer': 'http://localhost:8080',
      'X-Title': 'Video Combiner',
    });
  }

  throw new Error(`Unknown provider: ${provider}`);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate a structured video script.
 *
 * @param {object} params
 * @param {string} params.topic
 * @param {string} [params.niche]
 * @param {string} [params.tone]
 * @param {number} [params.duration_minutes=2]
 * @param {string} [params.style]
 * @param {string} [params.model='llama-3.3-70b-versatile']
 * @param {object} params.env  — process.env (passed by server, never expose raw to client)
 * @param {object} logger      — must have .log() and .error()
 * @returns {Promise<{ script, model_used, provider_used, tokens_used }>}
 */
async function generateScript(params, logger) {
  const {
    topic,
    niche = 'general',
    tone = 'informative',
    duration_minutes = 2,
    style = 'storytelling',
    model = 'llama-3.3-70b-versatile',
    env = process.env,
  } = params;

  if (!topic?.trim()) throw new Error('topic is required');

  const provider = resolveProvider(model);
  const userPrompt = buildUserPrompt({ topic, niche, tone, duration_minutes, style });
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let result = await callProvider(provider, model, messages, userPrompt, env, logger);
  logger.log(`📝 Response: ${result.content.length} chars, ${result.tokens} tokens`);

  let script;
  try {
    script = extractJson(result.content);
  } catch (_) {
    // Retry once with a correction message
    logger.log('⚠️  JSON parse failed — retrying with correction prompt…');
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: result.content },
      { role: 'user', content: 'Your response was not valid JSON. Output ONLY the raw JSON object, no markdown, no explanation.' },
    ];
    const retry = await callProvider(provider, model, retryMessages, userPrompt, env, logger);
    script = extractJson(retry.content);
    result.tokens += retry.tokens;
  }

  if (!script.narration || typeof script.narration !== 'string') {
    throw new Error('Generated script missing narration field');
  }

  logger.log(`✅ Script: "${script.title || topic}" — ${script.narration.split(/\s+/).length} words`);
  return { script, model_used: model, provider_used: provider, tokens_used: result.tokens };
}

// ── List available models per provider (for status endpoint) ──────────────────
function availableModels(env = process.env) {
  const out = [];
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const hasKey = p.envKeys.some(k => env[k]);
    if (hasKey) {
      p.models.forEach(m => out.push({ model: m, provider: name }));
    }
  }
  return out;
}

module.exports = { generateScript, availableModels, PROVIDERS };
