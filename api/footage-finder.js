// Footage Finder — queries Pexels, Pixabay, AND YouTube in parallel per scene.
// All clips are downloaded to FOOTAGE_DIR and served via /api/footage-file/:name.

// Node 16 compatibility
if (typeof fetch === 'undefined') { require('./script-generator'); }

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const FOOTAGE_DIR    = path.join(os.tmpdir(), 'vcombine_footage');
const USED_CLIPS_FILE = path.join(__dirname, '../footage/used_clips.json');

function ensureDir() {
  if (!fs.existsSync(FOOTAGE_DIR)) fs.mkdirSync(FOOTAGE_DIR, { recursive: true });
}

// ── Persistent cross-run clip registry ───────────────────────────────────────
// Tracks every clip ID that has been downloaded and used so that no clip ever
// appears twice across different scheduler job runs.
function loadUsedClips() {
  try {
    if (fs.existsSync(USED_CLIPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USED_CLIPS_FILE, 'utf8'));
      return new Set(Array.isArray(data) ? data : []);
    }
  } catch (_) {}
  return new Set();
}

function saveUsedClips(set) {
  try {
    fs.mkdirSync(path.dirname(USED_CLIPS_FILE), { recursive: true });
    fs.writeFileSync(USED_CLIPS_FILE, JSON.stringify([...set]));
  } catch (_) {}
}

// ── Mood / visual-style profiles ─────────────────────────────────────────────
// Each profile is a set of cinematic style tags appended to every stock API
// query to bias results toward a consistent visual aesthetic. Tags are chosen
// for high recall on Pexels / Pixabay — short, common photographic descriptors.
//
// Add a new entry here to support additional themes. The key is matched against
// the lowercased globalTheme string (substring match), so "cybersecurity" and
// "cyber dark tech" both resolve to the 'cyber' profile.
const MOOD_PROFILES = {
  cyber: {
    label:      'Cyber / Dark Tech',
    styleTags:  ['cinematic', 'dark', 'neon', 'high contrast'],
    llmStyle:   'cinematic, cool-toned, high contrast, low-key lighting, cyberpunk aesthetic — dark rooms, blue/green neon glow, dramatic shadows',
  },
  corporate: {
    label:      'Corporate / Professional',
    styleTags:  ['cinematic', 'bright', 'clean', 'office'],
    llmStyle:   'clean, bright, modern office aesthetic — natural lighting, neutral tones, professional environment',
  },
  nature: {
    label:      'Nature / Documentary',
    styleTags:  ['cinematic', 'golden hour', 'landscape', 'aerial'],
    llmStyle:   'golden hour, wide landscape, documentary aesthetic — warm tones, natural light, aerial or wide shots',
  },
  emotional: {
    label:      'Emotional / Human Interest',
    styleTags:  ['cinematic', 'warm', 'intimate', 'portrait'],
    llmStyle:   'warm, intimate, portrait-style — shallow depth of field, soft natural light, close human connection',
  },
};

// Keyword substrings that map a theme string to a profile key
const THEME_TO_PROFILE = [
  { match: /cyber|hack|digital|tech|data|privacy|surveillance|security/i, profile: 'cyber' },
  { match: /corporate|business|finance|office|professional|enterprise/i,  profile: 'corporate' },
  { match: /nature|wildlife|environment|climate|outdoor|forest|ocean/i,   profile: 'nature' },
  { match: /human|social|community|family|emotion|mental|health/i,        profile: 'emotional' },
];

function resolveMoodProfile(globalTheme) {
  if (!globalTheme) return null;
  for (const { match, profile } of THEME_TO_PROFILE) {
    if (match.test(globalTheme)) return MOOD_PROFILES[profile];
  }
  return null;
}

// Appends style tags to a query string without exceeding API query length limits.
// Only tags that are not already present in the query are added.
function applyMoodProfile(query, profile) {
  if (!profile?.styleTags?.length) return query;
  const lower = query.toLowerCase();
  const toAdd = profile.styleTags.filter(t => !lower.includes(t.toLowerCase()));
  if (!toAdd.length) return query;
  // Cap total query length at 100 chars so APIs don't reject or truncate it
  const suffix = ' ' + toAdd.join(' ');
  return (query + suffix).slice(0, 100).trim();
}

// Keywords that pull irrelevant stock footage regardless of topic
const KEYWORD_BLACKLIST = [
  'butterfly', 'butterflies', 'insect', 'flower macro', 'nature close',
  'spinning camera', 'vintage camera', 'camera product', 'camera spinning',
  'tropical pool', 'resort pool', 'bikini', 'beach resort',
  'period drama', 'aristocrat', 'wine glass vintage', 'dog walking park',
  'abstract background', 'bokeh', 'light leak', 'lens flare',
];

function applyKeywordBlacklist(keywords) {
  return keywords.filter(kw =>
    !KEYWORD_BLACKLIST.some(banned => kw.toLowerCase().includes(banned))
  );
}

// ── #17 AI Scene-to-Keyword Rewriter ─────────────────────────────────────────
// Rewrites abstract scene descriptions → concrete, searchable visual terms.
// One batched Groq call for all scenes; enriches scene.visual_keywords in-place.
// globalTheme anchors every query to the video's overarching subject so
// individual scene keywords can't drift into unrelated visual territory.
async function rewriteSceneKeywords(scenes, env, logger, globalTheme, moodProfile) {
  const groqKey = env.GROQ_API_KEY || env.GROQ_API_KEY_2 || env.GROQ_API_KEY_3;
  if (!groqKey || !scenes?.length) return scenes;
  try {
    const { callGroq } = require('./script-generator');
    const sceneList = scenes.map((s, i) =>
      `Scene ${i + 1} (id:${s.id}): "${s.description || s.narration?.slice(0, 120) || ''}"`
    ).join('\n');

    const themeInstruction = globalTheme
      ? `Global visual theme for ALL scenes: "${globalTheme}". Every keyword MUST be consistent with this theme.\n`
      : '';

    const moodInstruction = moodProfile
      ? `Visual mood profile: every keyword you generate must be compatible with the following\n` +
        `cinematic style — "${moodProfile.llmStyle}".\n` +
        `Prefer footage that would be shot in this aesthetic. Do NOT suggest keywords that would\n` +
        `return brightly lit, cheerful, or warm-toned stock clips unless the mood profile requires it.\n`
      : '';

    // context_validation: derive anti-examples from the theme so the LLM
    // understands which literal-but-wrong matches to actively avoid
    const contextValidation = globalTheme
      ? `Context validation: the theme "${globalTheme}" means footage must show technology,\n` +
        `screens, servers, people using computers, digital interfaces, or surveillance.\n` +
        `NEVER return keywords that could match food, cooking, nature, sport, fashion,\n` +
        `or lifestyle content even if a word in the script sounds like it could relate\n` +
        `(e.g. "cookies" = web tracking, NOT biscuits/baking; "phishing" = cyber attack,\n` +
        `NOT fishing; "breach" = data leak, NOT swimming pool).\n`
      : '';

    const { content } = await callGroq([
      {
        role: 'system',
        content:
          'You convert abstract video scene descriptions into concrete, searchable stock-footage keywords. ' +
          'You also identify terms that would produce false-positive results and must be excluded from API searches. ' +
          'Return ONLY a JSON array of objects.',
      },
      {
        role: 'user',
        content:
          `For each scene below, return:\n` +
          `  • 4-6 concrete positive search terms ("keywords") for stock footage APIs\n` +
          `  • 3-6 negative exclusion terms ("negative_keywords") that would return wrong results\n\n` +
          `Rules for POSITIVE keywords:\n` +
          `- Visually concrete (e.g. "hacker typing dark room" not "cybercrime")\n` +
          `- Prefer terms that return results on Pexels / Pixabay\n` +
          `- No abstract nouns alone (success, growth, future)\n` +
          `- Max 3 words per term\n` +
          `- Feature human subjects in professional/tech settings\n` +
          `- NEVER suggest: nature close-ups, food, cooking, sport, or lifestyle content\n\n` +
          `Rules for NEGATIVE keywords:\n` +
          `- Short single words or 2-word phrases only\n` +
          `- Must be terms a stock API could return as false-positive literal matches\n` +
          `- E.g. for cybersecurity: "baking", "cookies food", "fishing", "swimming", "kitchen"\n\n` +
          `${themeInstruction}` +
          `${moodInstruction}` +
          `${contextValidation}\n` +
          `${sceneList}\n\n` +
          `Return JSON array: [{"id": sceneId, "keywords": ["term1","term2"], "negative_keywords": ["excl1","excl2"]}]\n` +
          `Return ONLY the JSON array, no markdown.`,
      },
    ], 'llama-3.3-70b-versatile', env, { log: () => {} });

    const raw = content.trim().replace(/^```(?:json)?|```$/gm, '').trim();
    const enriched = JSON.parse(raw);
    if (!Array.isArray(enriched)) return scenes;

    enriched.forEach(({ id, keywords, negative_keywords }) => {
      const scene = scenes.find(s => String(s.id) === String(id));
      if (scene && Array.isArray(keywords)) {
        const cleaned = applyKeywordBlacklist(keywords.filter(Boolean));
        scene.visual_keywords = [
          ...cleaned,
          ...applyKeywordBlacklist(scene.visual_keywords || []),
        ].slice(0, 8);
      }
      // Merge LLM-generated negatives with any pre-existing ones on the scene
      if (scene && Array.isArray(negative_keywords)) {
        scene.negative_keywords = [
          ...new Set([
            ...(scene.negative_keywords || []),
            ...negative_keywords.filter(Boolean).map(k => k.toLowerCase().trim()),
          ]),
        ];
      }
    });
    logger?.log?.(`🔍 Scene keywords rewritten for ${enriched.length} scenes`);
  } catch (e) {
    logger?.log?.(`   ⚠️  Keyword rewrite failed (non-fatal): ${e.message}`);
  }
  return scenes;
}

// ── Negative keyword helpers ──────────────────────────────────────────────────

// Builds the ` -term1 -term2` suffix used by Pixabay's search API.
function buildPixabayNegativeSuffix(negativeTerms = []) {
  if (!negativeTerms.length) return '';
  return ' ' + negativeTerms.map(t => `-${t.trim().split(/\s+/)[0]}`).join(' ');
}

// Returns true if any negative term appears in the candidate string.
function matchesNegative(candidate = '', negativeTerms = []) {
  const lower = candidate.toLowerCase();
  return negativeTerms.some(t => lower.includes(t.toLowerCase()));
}

// ── Pexels ────────────────────────────────────────────────────────────────────
// Pexels does not expose a native exclusion parameter, so negative filtering is
// applied client-side against the video's page URL and the originating query.
async function searchPexels(query, apiKey, perPage = 4, orientation = 'landscape', negativeTerms = []) {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orientation}&size=medium`;
  const r = await fetch(url, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Pexels ${r.status}: ${txt.slice(0, 120)}`);
  }
  const data = await r.json();
  return (data.videos || []).flatMap(v => {
    const files = (v.video_files || []).filter(f => f.link && f.file_type === 'video/mp4');
    files.sort((a, b) => Math.abs(a.height - 720) - Math.abs(b.height - 720));
    const best = files[0];
    if (!best?.link) return [];

    // Client-side negative filter: check page URL and any available tag text
    const checkStr = [v.url || '', (v.tags || []).join(' ')].join(' ');
    if (negativeTerms.length && matchesNegative(checkStr, negativeTerms)) return [];

    return [{
      id:        `pexels_${v.id}`,
      url:       best.link,
      thumbnail: v.image,
      duration:  v.duration,
      width:     best.width,
      height:    best.height,
      source:    'pexels',
      query,
    }];
  });
}

// ── Pixabay ───────────────────────────────────────────────────────────────────
// Pixabay supports `-term` exclusion natively in the `q` parameter.
async function searchPixabay(query, apiKey, perPage = 4, orientation = 'landscape', negativeTerms = []) {
  const effectiveQuery = query + buildPixabayNegativeSuffix(negativeTerms);
  const url = `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(effectiveQuery)}&video_type=film&per_page=${perPage}&safesearch=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Pixabay ${r.status}`);
  const data = await r.json();
  return (data.hits || []).flatMap(v => {
    const vid = v.videos?.medium || v.videos?.large || v.videos?.small;
    if (!vid?.url) return [];
    const ratio = vid.width / (vid.height || 1);
    const isPortrait  = ratio < 0.8;
    const isLandscape = ratio > 1.2;
    if (orientation === 'portrait'  && !isPortrait)  return [];
    if (orientation === 'landscape' && !isLandscape) return [];

    // Client-side secondary filter against tags for extra safety
    const checkStr = (v.tags || '');
    if (negativeTerms.length && matchesNegative(checkStr, negativeTerms)) return [];

    return [{
      id:        `pixabay_${v.id}`,
      url:       vid.url,
      thumbnail: v.userImageURL || '',
      duration:  null,
      width:     vid.width,
      height:    vid.height,
      source:    'pixabay',
      query,
    }];
  });
}

// ── YouTube ───────────────────────────────────────────────────────────────────
// Returns search results (no download yet) shaped like Pexels/Pixabay results.
async function searchYouTubeFootage(query, perPage = 2, logger) {
  try {
    const { searchYouTube } = require('./youtube-search');
    const results = await searchYouTube(query, {
      limit:  perPage + 2,   // extra headroom — long videos filtered below
      filter: 'any',
      logger,
    });
    // Prefer shorter videos (under 10 min) for B-roll; skip very long ones
    const filtered = results.filter(v => !v.duration || v.duration < 600);
    return filtered.slice(0, perPage).map(v => ({
      id:        `youtube_${v.id}`,
      ytId:      v.id,
      ytUrl:     v.url,
      url:       v.url,          // used as display URL; actual download via yt-dlp
      thumbnail: v.thumbnail,
      duration:  v.duration,
      title:     v.title,
      source:    'youtube',
      query,
    }));
  } catch (e) {
    logger?.log?.(`   ⚠️  YouTube search: ${e.message}`);
    return [];
  }
}

// ── Download helpers ──────────────────────────────────────────────────────────

// Direct HTTP download (Pexels / Pixabay CDN URLs)
async function downloadClipHTTP(url, filename, logger) {
  ensureDir();
  const dest = path.join(FOOTAGE_DIR, filename);
  if (fs.existsSync(dest)) return dest;

  logger.log(`   ⬇️  ${filename} ← ${url.replace(/\?.*/, '').slice(0, 70)}…`);
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`Download ${r.status}: ${url.slice(0, 60)}`);
  const buf = await r.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
  logger.log(`   ✅ ${filename} — ${(buf.byteLength / 1048576).toFixed(1)} MB`);
  return dest;
}

// yt-dlp download (YouTube clips) — transcript-aware partial download
// If scene is provided, fetches the transcript first and uses --download-sections
// to only pull the relevant time window instead of the full video.
async function downloadClipYT(ytUrl, filename, quality = '720', logger, scene = null, clipSecs = 15) {
  ensureDir();
  const dest = path.join(FOOTAGE_DIR, filename);
  if (fs.existsSync(dest)) return dest;

  const YT_DLP = (() => {
    const { execFileSync } = require('child_process');
    for (const c of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
      if (fs.existsSync(c)) return c;
    }
    try { return execFileSync('which', ['yt-dlp'], { timeout: 3000 }).toString().trim() || 'yt-dlp'; } catch (_) { return 'yt-dlp'; }
  })();

  const fmtMap = {
    '720':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]',
    '480':  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
    '1080': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  };
  const fmt = fmtMap[quality] || fmtMap['720'];

  // ── Step 1: find best scene timestamp via transcript ──────────────────────
  let startSec = null;
  if (scene) {
    try {
      const { findSceneTimestamp } = require('./youtube-transcript');
      startSec = await findSceneTimestamp(ytUrl, scene, logger);
    } catch (e) {
      logger.log(`   ℹ️  Transcript match skipped: ${e.message?.slice(0, 60)}`);
    }
  }

  // ── Step 2: build yt-dlp args ─────────────────────────────────────────────
  const cookieArgs = [];
  try {
    const { cookiesExist, COOKIE_PATH } = require('./youtube-auth');
    if (cookiesExist()) cookieArgs.push('--cookies', COOKIE_PATH);
  } catch (_) {}

  const args = [
    '--format', fmt,
    '--merge-output-format', 'mp4',
    '--output', dest,
    '--no-playlist',
    '--force-keyframes-at-cuts',   // cut exactly at the requested timestamp
    '--quiet',
    '--no-warnings',
    '--no-progress',
    ...cookieArgs,
  ];

  if (startSec !== null) {
    // Only download the matched window + a small buffer
    const bufferSec = 3;
    const from  = Math.max(0, startSec - bufferSec);
    const to    = startSec + clipSecs + bufferSec;
    const { fmtSecs } = require('./youtube-transcript');
    const section = `*${fmtSecs(from)}-${fmtSecs(to)}`;
    args.push('--download-sections', section);
    logger.log(`   🎬 ${filename} ← YouTube [${fmtSecs(from)}→${fmtSecs(to)}] (transcript match)`);
  } else {
    // No transcript match — download only first ~60s to avoid huge files, then let
    // the scheduler's extractOne pick a random non-zero offset
    const fallbackEnd = clipSecs * 4; // 4× the clip length as headroom
    const { fmtSecs } = require('./youtube-transcript');
    args.push('--download-sections', `*0:00-${fmtSecs(fallbackEnd)}`);
    logger.log(`   🎬 ${filename} ← YouTube [0:00→${fmtSecs(fallbackEnd)}] (no transcript)`);
  }

  args.push(ytUrl);

  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  await execFileAsync(YT_DLP, args, { timeout: 180_000, maxBuffer: 50 * 1024 * 1024 });

  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    throw new Error(`yt-dlp produced no output for ${ytUrl.slice(-30)}`);
  }

  const sizeMB = (fs.statSync(dest).size / 1048576).toFixed(1);
  logger.log(`   ✅ ${filename} — ${sizeMB} MB (YouTube section)`);
  return dest;
}

// ── Combined search — Pexels + Pixabay + YouTube in parallel ─────────────────
async function searchAll(query, env, perPage, logger, orientation = 'landscape', useYoutube = false, usePexels = true, usePixabay = true, negativeTerms = []) {
  const pexelsKey  = env.PEXELS_API_KEY;
  const pixabayKey = env.PIXABAY_API_KEY;

  if (!useYoutube && !usePexels && !usePixabay) {
    throw new Error('No footage sources enabled');
  }

  const tasks = [
    (usePexels  && pexelsKey)  ? searchPexels(query,  pexelsKey,  perPage, orientation, negativeTerms) : Promise.resolve([]),
    (usePixabay && pixabayKey) ? searchPixabay(query, pixabayKey, perPage, orientation, negativeTerms) : Promise.resolve([]),
    useYoutube ? searchYouTubeFootage(query, perPage, logger)                                          : Promise.resolve([]),
  ];

  const [pexelsRes, pixabayRes, youtubeRes] = await Promise.allSettled(tasks);

  const pexels  = pexelsRes.status  === 'fulfilled' ? pexelsRes.value  : [];
  const pixabay = pixabayRes.status === 'fulfilled' ? pixabayRes.value : [];
  const youtube = youtubeRes.status === 'fulfilled' ? youtubeRes.value : [];

  if (pexelsRes.status  === 'rejected') logger?.log?.(`   ⚠️  Pexels: ${pexelsRes.reason?.message}`);
  if (pixabayRes.status === 'rejected') logger?.log?.(`   ⚠️  Pixabay: ${pixabayRes.reason?.message}`);
  if (youtubeRes.status === 'rejected') logger?.log?.(`   ⚠️  YouTube: ${youtubeRes.reason?.message}`);

  // Interleave: pexels, pixabay, youtube, pexels, pixabay, youtube …
  const merged = [];
  const len = Math.max(pexels.length, pixabay.length, youtube.length);
  for (let i = 0; i < len; i++) {
    if (i < pexels.length)  merged.push(pexels[i]);
    if (i < pixabay.length) merged.push(pixabay[i]);
    if (i < youtube.length) merged.push(youtube[i]);
  }
  return merged;
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Search Pexels, Pixabay, and optionally YouTube for each scene's keywords,
 * download the clips, and return clip objects ready for the pipeline.
 *
 * @param {Array<{id, visual_keywords, description}>} scenes
 * @param {object} env
 * @param {object} logger
 * @param {number} [clipsPerScene=2]
 * @param {string} [orientation='landscape']
 * @param {boolean} [useYoutube=false]
 * @param {string}  [ytQuality='720']
 */
async function findFootageForScenes(
  scenes, env, logger,
  clipsPerScene = 2,
  orientation   = 'landscape',
  useYoutube    = false,
  usePexels     = true,
  usePixabay    = true,
  ytQuality     = '720',
  globalTheme   = null,
  moodProfile   = null,   // explicit profile object; auto-resolved from globalTheme if null
) {
  const pexelsKey  = env.PEXELS_API_KEY;
  const pixabayKey = env.PIXABAY_API_KEY;

  if (!useYoutube && !usePexels && !usePixabay) {
    throw new Error('No footage sources enabled');
  }
  if (!pexelsKey && !pixabayKey && !useYoutube) {
    throw new Error('No footage source configured. Add PEXELS_API_KEY / PIXABAY_API_KEY to .env, or enable YouTube.');
  }

  ensureDir();

  // #17 Rewrite abstract scene descriptions → concrete visual keywords
  const resolvedTheme   = globalTheme || env.GLOBAL_THEME || null;
  const resolvedProfile = moodProfile || resolveMoodProfile(resolvedTheme) || null;

  if (resolvedProfile) {
    logger.log(`🎨 Mood profile: "${resolvedProfile.label}" — style tags: [${resolvedProfile.styleTags.join(', ')}]`);
  }

  if (env.GROQ_API_KEY || env.GROQ_API_KEY_2 || env.GROQ_API_KEY_3) {
    scenes = await rewriteSceneKeywords(scenes, env, logger, resolvedTheme, resolvedProfile);
  }

  // Evict footage older than 2 hours
  try {
    const cutoff = Date.now() - 2 * 3600_000;
    for (const f of fs.readdirSync(FOOTAGE_DIR)) {
      const fp = path.join(FOOTAGE_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch (_) {}

  // ── Build tiered query list for a scene ────────────────────────────────────
  function buildQueryTiers(scene) {
    const kw   = (scene.visual_keywords  || []).filter(Boolean);
    const sq   = (scene.search_queries   || []).filter(Boolean);
    const desc = (scene.description      || '').split(/\s+/).slice(0, 4).join(' ');
    const raw  = [];

    // Tier 0: pre-built search_queries from the LLM (most reliable)
    sq.forEach(q => raw.push(q.trim()));

    // Tier 1: all keywords joined (specific combo)
    if (kw.length >= 2) raw.push(kw.slice(0, 3).join(' '));

    // Tier 2: first keyword alone (still specific, fewer words)
    if (kw.length >= 1) raw.push(kw[0]);

    // Tier 3: second keyword (medium specificity)
    if (kw.length >= 2) raw.push(kw[1]);

    // Tier 4: description snippet
    if (desc) raw.push(desc);

    // Tier 5: third keyword (broad category)
    if (kw.length >= 3) raw.push(kw[2]);

    // Tier 6: fourth keyword (broad fallback)
    if (kw.length >= 4) raw.push(kw[3]);

    // Tier 7: fifth keyword (universal fallback)
    if (kw.length >= 5) raw.push(kw[4]);

    // Ultimate fallback: human-centric, always returns results
    raw.push('people working together');

    // Deduplicate, then apply mood-profile style tags to every query tier.
    // applyMoodProfile appends tags only when absent and respects a 100-char cap.
    const deduped = [...new Set(raw.map(t => t.toLowerCase().trim()))].filter(Boolean);
    return deduped.map(q => applyMoodProfile(q, resolvedProfile));
  }

  // Persistent cross-run registry — loaded once per findFootageForScenes call
  const persistedUsedIds = loadUsedClips();

  // In-run dedup sets (within this pipeline execution)
  const globalSeenUrls = new Set();
  const globalSeenIds  = new Set();

  // Merge persisted IDs into in-run set so we reject them immediately
  for (const id of persistedUsedIds) globalSeenIds.add(id);

  // Accumulates newly-used IDs to flush to disk after all scenes finish
  const newlyUsedIds = new Set();

  // ── Try each query tier until we have enough clips for a scene ──────────────
  async function downloadForScene(scene, want) {
    const tiers        = buildQueryTiers(scene);
    const sceneNeg     = (scene.negative_keywords || []);
    const sources      = [usePexels && 'Pexels', usePixabay && 'Pixabay', useYoutube && 'YouTube'].filter(Boolean).join(' + ');
    const clips        = [];

    for (const query of tiers) {
      if (clips.length >= want) break;
      const still = want - clips.length;
      logger.log(`🔍 Scene ${scene.id}: "${query}" [${orientation}] (${sources})…`);
      if (sceneNeg.length) {
        logger.log(`   🚫 Excluding: ${sceneNeg.slice(0, 6).join(', ')}`);
      }

      let candidates;
      try {
        candidates = await searchAll(query, env, still + 5, logger, orientation, useYoutube, usePexels, usePixabay, sceneNeg);
      } catch (e) {
        logger.log(`   ⚠️  Search error (${query}): ${e.message}`);
        continue;
      }

      // #12 B-Roll Shuffle: randomize candidate order on every run
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }

      // Filter against in-run AND cross-run seen sets
      const fresh = candidates.filter(c => {
        const id = c.id || c.url;
        if (globalSeenUrls.has(c.url) || globalSeenIds.has(id)) return false;
        globalSeenUrls.add(c.url);
        globalSeenIds.add(id);
        return true;
      });

      if (!fresh.length) continue;

      for (const clip of fresh) {
        if (clips.length >= want) break;
        try {
          const filename  = `footage_s${scene.id}_${clip.source}_${crypto.randomBytes(4).toString('hex')}.mp4`;
          const localPath = clip.source === 'youtube'
            ? await downloadClipYT(clip.ytUrl, filename, ytQuality, logger, scene, 15)
            : await downloadClipHTTP(clip.url, filename, logger);
          const effectiveDuration = clip.source === 'youtube' ? 18 : (clip.duration || null);
          const clipId = clip.id || clip.url;
          newlyUsedIds.add(clipId);
          clips.push({ ...clip, filename, localPath, scene_id: scene.id, duration: effectiveDuration, serveUrl: `/api/footage-file/${filename}` });
        } catch (err) {
          logger.log(`   ⚠️  Download failed (${clip.source}): ${err.message}`);
        }
      }
    }
    return clips;
  }

  // ── Download all scenes in parallel ─────────────────────────────────────────
  const { findImagesForScene } = (() => { try { return require('./image-finder'); } catch(_) { return {}; } })();

  const settled = await Promise.allSettled(scenes.map(scene => downloadForScene(scene, clipsPerScene)));

  const results = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene  = scenes[i];
    const result = settled[i];
    const clips  = result.status === 'fulfilled' ? result.value : [];

    if (!clips.length) {
      logger.log(`   ⚠️  No video clips for scene ${scene.id} — falling back to image search…`);
      if (typeof findImagesForScene === 'function') {
        try {
          const imageClips = await findImagesForScene(scene, env, logger, clipsPerScene, orientation, 5);
          if (imageClips.length) {
            logger.log(`   🖼️  Image fallback: ${imageClips.length} still(s) → video clips for scene ${scene.id}`);
            results.push(...imageClips);
          } else {
            logger.log(`   ⚠️  Image fallback also empty for scene ${scene.id}`);
          }
        } catch (imgErr) {
          logger.log(`   ⚠️  Image fallback error scene ${scene.id}: ${imgErr.message}`);
        }
      }
    } else {
      results.push(...clips);
    }
  }

  // Persist newly-used clip IDs so future runs won't reuse them
  if (newlyUsedIds.size > 0) {
    for (const id of newlyUsedIds) persistedUsedIds.add(id);
    saveUsedClips(persistedUsedIds);
    logger.log(`📋 Clip registry updated — ${persistedUsedIds.size} total unique clip(s) on record`);
  }

  const totalDur = results.reduce((s, c) => s + (c.duration || 8), 0);
  const videoCount = results.filter(c => !c.isImage).length;
  const imageCount = results.filter(c =>  c.isImage).length;
  logger.log(`✅ Footage finder done — ${videoCount} video clip(s) + ${imageCount} image clip(s), ~${totalDur.toFixed(0)}s raw footage`);
  return results;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function clearAllFootage(logger) {
  ensureDir();
  let count = 0, bytes = 0;
  for (const f of fs.readdirSync(FOOTAGE_DIR)) {
    try {
      const fp = path.join(FOOTAGE_DIR, f);
      bytes += fs.statSync(fp).size;
      fs.unlinkSync(fp);
      count++;
    } catch (_) {}
  }
  if (logger) logger.log(`🗑️  Cleared ${count} footage file(s) (${(bytes / 1048576).toFixed(1)} MB)`);
  return { count, bytes };
}

function removeClip(filename) {
  try { fs.unlinkSync(path.join(FOOTAGE_DIR, filename)); } catch (_) {}
}

module.exports = { findFootageForScenes, rewriteSceneKeywords, removeClip, clearAllFootage, FOOTAGE_DIR };
