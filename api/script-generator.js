// Groq-powered script generator for faceless video automation
// Uses the OpenAI-compatible Groq API — no npm package needed, pure fetch.

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

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

function buildUserPrompt(params) {
  const { topic, niche, tone, duration_minutes, style } = params;
  const words = Math.round(duration_minutes * 150);
  return [
    `Topic: ${topic}`,
    `Niche: ${niche || 'general'}`,
    `Tone: ${tone || 'informative'}`,
    `Style: ${style || 'storytelling'}`,
    `Target duration: ${duration_minutes} minute${duration_minutes !== 1 ? 's' : ''} (~${words} words of narration)`,
    '',
    'Write the complete script now. Output JSON only.'
  ].join('\n');
}

function extractJson(text) {
  // Strip any accidental markdown fences
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  // Try direct parse first
  try {
    return JSON.parse(stripped);
  } catch (_) {}

  // Fallback: grab the first { ... } block
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0]);
  }

  throw new Error('Model response was not valid JSON');
}

async function callGroq(messages, model, apiKey, logger) {
  logger.log(`🤖 Calling Groq (${model})...`);

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.8,
      max_completion_tokens: 4096,
      top_p: 1
    }),
    signal: AbortSignal.timeout(60_000)
  });

  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }

  return response.json();
}

/**
 * Generate a structured video script via the Groq API.
 *
 * @param {object} params
 * @param {string} params.topic
 * @param {string} [params.niche]
 * @param {string} [params.tone]
 * @param {number} [params.duration_minutes=2]
 * @param {string} [params.style]
 * @param {string} [params.model='llama-3.3-70b-versatile']
 * @param {string} params.groq_api_key
 * @param {object} logger  — must have .log() and .error()
 * @returns {Promise<{ script: object, model_used: string, tokens_used: number }>}
 */
async function generateScript(params, logger) {
  const {
    topic,
    niche = 'general',
    tone = 'informative',
    duration_minutes = 2,
    style = 'storytelling',
    model = 'llama-3.3-70b-versatile',
    groq_api_key
  } = params;

  if (!topic || !topic.trim()) throw new Error('topic is required');
  if (!groq_api_key) throw new Error('GROQ_API_KEY not configured on server');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt({ topic, niche, tone, duration_minutes, style }) }
  ];

  let data = await callGroq(messages, model, groq_api_key, logger);
  const rawContent = data.choices?.[0]?.message?.content || '';
  const tokensUsed = data.usage?.total_tokens || 0;

  logger.log(`📝 Received ${rawContent.length} chars (${tokensUsed} tokens)`);

  let script;
  try {
    script = extractJson(rawContent);
  } catch (parseErr) {
    // Retry once with an explicit correction message
    logger.log('⚠️  JSON parse failed — retrying with correction prompt...');
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: rawContent },
      { role: 'user', content: 'Your response was not valid JSON. Output ONLY the raw JSON object, no markdown, no explanation.' }
    ];
    const retryData = await callGroq(retryMessages, model, groq_api_key, logger);
    const retryContent = retryData.choices?.[0]?.message?.content || '';
    script = extractJson(retryContent);
  }

  // Basic validation
  if (!script.narration || typeof script.narration !== 'string') {
    throw new Error('Generated script missing narration field');
  }

  logger.log(`✅ Script generated: "${script.title || topic}" — ${script.narration.split(/\s+/).length} words`);

  return { script, model_used: model, tokens_used: tokensUsed };
}

module.exports = { generateScript };
