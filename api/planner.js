// Content Planner — AI-powered brainstorm + validation.
// Reuses the same callGroq helper as script-generator (round-robin key rotation).

const { callGroq } = require('./script-generator');

// ── Strip markdown fences, find and return the JSON substring ─────────────────
function extractJSON(raw) {
  let txt = (raw || '').trim();
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // Find first [ or { and last ] or }
  const s = txt.search(/[\[{]/);
  const e = Math.max(txt.lastIndexOf(']'), txt.lastIndexOf('}'));
  if (s !== -1 && e > s) txt = txt.slice(s, e + 1);
  return JSON.parse(txt);
}

// ── #21 Trend Injection: fetch Reddit hot posts for a niche ──────────────────
// Maps niche keywords to relevant subreddits and pulls top headlines.
const NICHE_SUBREDDITS = {
  finance:      ['personalfinance','financialindependence','investing'],
  tech:         ['technology','gadgets','Futurology'],
  health:       ['health','fitness','nutrition'],
  fitness:      ['fitness','bodyweightfitness','loseit'],
  mindset:      ['selfimprovement','productivity','getdisciplined'],
  business:     ['Entrepreneur','smallbusiness','startups'],
  ai:           ['artificial','MachineLearning','ChatGPT'],
  travel:       ['travel','solotravel','backpacking'],
  food:         ['food','recipes','MealPrepSunday'],
  crypto:       ['CryptoCurrency','Bitcoin','ethereum'],
  relationships:['relationship_advice','dating_advice','socialskills'],
  education:    ['learnprogramming','learnpython','languagelearning'],
  default:      ['videos','TrueOffMyChest','todayilearned'],
};

async function fetchTrendingTopics(niche, logger) {
  try {
    const nicheKey = Object.keys(NICHE_SUBREDDITS).find(k =>
      niche.toLowerCase().includes(k)
    ) || 'default';
    const subs = NICHE_SUBREDDITS[nicheKey];
    const sub  = subs[Math.floor(Math.random() * subs.length)];
    const url  = `https://www.reddit.com/r/${sub}/hot.json?limit=15&raw_json=1`;
    const r    = await fetch(url, {
      headers: { 'User-Agent': 'video-combine/1.0' },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const data  = await r.json();
    const posts = (data?.data?.children || [])
      .map(c => c.data)
      .filter(p => !p.stickied && p.score > 100)
      .slice(0, 8)
      .map(p => p.title);
    if (!posts.length) return null;
    logger?.log?.(`📈 Trend injection: ${posts.length} hot posts from r/${sub}`);
    return { subreddit: sub, posts };
  } catch (e) {
    logger?.log?.(`   ⚠️  Trend fetch failed (non-fatal): ${e.message}`);
    return null;
  }
}

// ── Brainstorm: generate N video ideas ───────────────────────────────────────
async function brainstormIdeas(params, logger) {
  const {
    niche      = '',
    platform   = 'YouTube',
    goal       = 'grow audience',
    count      = 8,
    tone       = '',
    avoid      = '',
    model      = 'llama-3.3-70b-versatile',
    env        = process.env,
    use_trends = true,  // #21 trend injection (default on)
  } = params;

  logger?.log?.(`💡 Brainstorming ${count} ideas for "${niche}" on ${platform}…`);

  // #21 Fetch trending context
  let trendContext = '';
  if (use_trends && niche) {
    const trends = await fetchTrendingTopics(niche, logger);
    if (trends?.posts?.length) {
      trendContext =
        `\nCurrently trending on Reddit (r/${trends.subreddit}) — use these as inspiration for timely angles:\n` +
        trends.posts.map((t, i) => `  ${i+1}. "${t}"`).join('\n') + '\n';
    }
  }

  const systemPrompt =
    'You are an expert faceless YouTube content strategist who specialises in viral video ideas. ' +
    'Respond ONLY with a valid JSON array — no markdown, no prose, no explanation.';

  const userPrompt =
    `Generate exactly ${count} unique, high-potential video ideas for a faceless ${platform} channel.\n\n` +
    `Channel niche: ${niche || '(general — suggest strong niches)'}\n` +
    `Platform: ${platform}\n` +
    `Primary goal: ${goal}\n` +
    `Preferred tone: ${tone || 'any'}\n` +
    (avoid ? `Avoid: ${avoid}\n` : '') +
    trendContext +
    `\nEach idea object must have EXACTLY these fields:\n` +
    `{\n` +
    `  "id": number (1-${count}),\n` +
    `  "title": "compelling video title under 70 chars",\n` +
    `  "hook": "the exact opening line that would stop scrolling (1-2 sentences)",\n` +
    `  "angle": "the unique angle or contrarian take that makes this stand out",\n` +
    `  "niche": "sub-niche this fits",\n` +
    `  "tone": "calm | energetic | educational | inspirational | mysterious | controversial",\n` +
    `  "style": "storytelling | listicle | explainer | documentary | case-study",\n` +
    `  "duration_minutes": number (1-10),\n` +
    `  "target_audience": "who this is for",\n` +
    `  "viral_score": number 1-10,\n` +
    `  "competition": "low | medium | high",\n` +
    `  "monetisation": "AdSense | sponsorship | affiliate | digital product | none",\n` +
    `  "rationale": "2-3 sentences: why this works algorithmically"\n` +
    `}\n\n` +
    `Return the JSON array ONLY. No markdown. No extra text.`;

  const { content: raw } = await callGroq(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    model, env, logger,
  );

  let ideas;
  try {
    ideas = extractJSON(raw);
  } catch (_) {
    logger?.log?.('⚠️  JSON parse failed — retrying with stricter instruction…');
    const { content: raw2 } = await callGroq(
      [
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: userPrompt },
        { role: 'assistant', content: raw },
        { role: 'user',      content: 'Your response could not be parsed as JSON. Return ONLY the raw JSON array, nothing else, no markdown.' },
      ],
      model, env, logger,
    );
    ideas = extractJSON(raw2);
  }

  if (!Array.isArray(ideas)) throw new Error('Expected a JSON array of ideas from the model');
  logger?.log?.(`✅ Generated ${ideas.length} ideas`);
  return ideas;
}

// ── Validate: deep analysis of a single idea ─────────────────────────────────
async function validateIdea(idea, params, logger) {
  const {
    niche    = idea?.niche || '',
    platform = 'YouTube',
    model    = 'llama-3.3-70b-versatile',
    env      = process.env,
  } = params;

  logger?.log?.(`🔍 Validating: "${idea.title}"…`);

  const systemPrompt =
    'You are a brutally honest YouTube growth strategist. ' +
    'Validate video ideas based on data, trends, and production feasibility. ' +
    'Respond ONLY with valid JSON — no markdown, no prose.';

  const userPrompt =
    `Validate this video idea for a faceless ${platform} channel in the "${niche}" niche.\n\n` +
    `Idea:\n` +
    `- Title: ${idea.title}\n` +
    `- Hook: ${idea.hook || '—'}\n` +
    `- Angle: ${idea.angle || '—'}\n` +
    `- Tone: ${idea.tone || '—'}\n` +
    `- Style: ${idea.style || '—'}\n` +
    `- Duration: ${idea.duration_minutes || '?'} min\n` +
    `- Target audience: ${idea.target_audience || '—'}\n\n` +
    `Return exactly this JSON object (no markdown, no extra text):\n` +
    `{\n` +
    `  "overall_score": number 1-10,\n` +
    `  "verdict": "greenlight | refine | skip",\n` +
    `  "verdict_reason": "1 sentence summary",\n` +
    `  "strengths": ["up to 4 specific strengths"],\n` +
    `  "risks": ["up to 4 honest risks"],\n` +
    `  "improvements": ["up to 4 concrete improvements"],\n` +
    `  "refined_title": "improved title or same if already strong",\n` +
    `  "refined_hook": "improved opening line or same if strong",\n` +
    `  "keywords": ["8-12 SEO keywords"],\n` +
    `  "thumbnail_concept": "high-CTR thumbnail description in 1-2 sentences",\n` +
    `  "estimated_reach": "realistic view range in first 30 days e.g. 200-800 views",\n` +
    `  "monetisation_fit": "best monetisation model and why",\n` +
    `  "production_notes": "key production focus points"\n` +
    `}`;

  const { content: raw } = await callGroq(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    model, env, logger,
  );

  let result;
  try {
    result = extractJSON(raw);
  } catch (_) {
    logger?.log?.('⚠️  Parse failed — retrying…');
    const { content: raw2 } = await callGroq(
      [
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: userPrompt },
        { role: 'assistant', content: raw },
        { role: 'user',      content: 'Return ONLY the raw JSON object, no markdown, no other text.' },
      ],
      model, env, logger,
    );
    result = extractJSON(raw2);
  }

  logger?.log?.(`✅ Validation: ${result.overall_score}/10 (${result.verdict})`);
  return result;
}

// ── Refine: rewrite idea based on validation feedback ────────────────────────
async function refineIdea(idea, validation, params, logger) {
  const {
    platform = 'YouTube',
    model    = 'llama-3.3-70b-versatile',
    env      = process.env,
  } = params;

  logger?.log?.(`✏️  Refining: "${idea.title}"…`);

  const userPrompt =
    `Rewrite this video idea applying the validation feedback. ` +
    `Return ONLY the updated idea as a JSON object with the same fields as the original.\n\n` +
    `Original idea:\n${JSON.stringify(idea, null, 2)}\n\n` +
    `Validation feedback:\n` +
    `- Risks: ${(validation.risks || []).join('; ')}\n` +
    `- Improvements: ${(validation.improvements || []).join('; ')}\n` +
    `- Refined title suggestion: ${validation.refined_title || '—'}\n` +
    `- Refined hook suggestion: ${validation.refined_hook || '—'}\n\n` +
    `Apply all improvements. Keep the core concept but make it stronger. Return the full idea JSON object only.`;

  const { content: raw } = await callGroq(
    [
      { role: 'system', content: 'You are a content strategist. Return only valid JSON, no markdown.' },
      { role: 'user',   content: userPrompt },
    ],
    model, env, logger,
  );

  const refined = extractJSON(raw);
  logger?.log?.('✅ Idea refined');
  return refined;
}

module.exports = { brainstormIdeas, validateIdea, refineIdea };
