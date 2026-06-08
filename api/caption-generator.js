// Caption generator — Groq Whisper transcription + modern CapCut-style ASS subtitle rendering
// Uses \t() animated transforms for pop-in effects, word-by-word or 2-word group modes.

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// ── ASS colour helpers ─────────────────────────────────────────────────────────
// ASS format: &HAABBGGRR  (alpha 00=opaque, FF=transparent)
// rgb(r,g,b) → ASS  &H00BBGGRR
const rgb  = (r,g,b)     => `&H00${hex(b)}${hex(g)}${hex(r)}`;
const rgba = (r,g,b,a)   => `&H${hex(Math.round((1-a)*255))}${hex(b)}${hex(g)}${hex(r)}`;
const hex  = n            => Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0').toUpperCase();

// ── Templates ──────────────────────────────────────────────────────────────────
//
// renderMode:
//   'group'  — show N words at once, pop-in as a unit  (default)
//   'word'   — one word at a time with pop-in
//   'karaoke'— N-word group, active word is colour-swapped + scaled
//
// popIn: true → use \t() scale pop-in animation (80ms overshoot bounce)
// slideUp: true → translate from +20px below into position (100ms)
// blurIn: true → start blurred (\blur8) and sharpen over 120ms
// wordsPerLine: how many words per caption group (ignored in 'word' mode)
// fontSize: relative to 1080p height
// marginV: pixels from the bottom of the frame
// scaleX, scaleY: font stretch (100=normal, 105=slightly wide)

const TEMPLATES = {

  // ── 1. Impact — the TikTok / CapCut default ──────────────────────────────
  impact: {
    label: 'Impact',
    desc:  '2-word pop groups, thick black outline — the viral default',
    fontName:     'Arial Black',
    fontSize:     88,
    primaryColor: rgb(255,255,255),
    outlineColor: rgb(0,0,0),
    backColor:    rgba(0,0,0,0),
    bold:         true,
    outline:      4.5,
    shadow:       0,
    borderStyle:  1,
    spacing:      0,
    scaleX:       100,
    scaleY:       100,
    alignment:    2,
    marginV:      90,
    uppercase:    true,
    wordsPerLine: 2,
    renderMode:   'group',
    popIn:        true,
    slideUp:      false,
    blurIn:       false,
    fade:         [0, 0],
    preview: { bg:'#111', color:'#fff', outlineColor:'#000', text:'TWO WORDS', font:'Arial Black', bold:true, size:26 },
  },

  // ── 2. Highlight — white phrase, yellow pop on active word ───────────────
  highlight: {
    label: 'Highlight',
    desc:  '3-word groups, white text — active word jumps yellow',
    fontName:       'Arial Black',
    fontSize:       82,
    primaryColor:   rgb(255,255,255),
    highlightColor: rgb(255,220,0),
    highlightScale: 115,           // active word scales up to 115%
    outlineColor:   rgb(0,0,0),
    backColor:      rgba(0,0,0,0),
    bold:           true,
    outline:        3.5,
    shadow:         0,
    borderStyle:    1,
    spacing:        0,
    scaleX:         100,
    scaleY:         100,
    alignment:      2,
    marginV:        90,
    uppercase:      true,
    wordsPerLine:   3,
    renderMode:     'karaoke',
    popIn:          true,
    slideUp:        false,
    blurIn:         false,
    fade:           [0, 0],
    preview: { bg:'#111', color:'#fff', outlineColor:'#000', text:'WORD <span style="color:#ffdc00">POP</span> HERE', font:'Arial Black', bold:true, size:22 },
  },

  // ── 3. Neon — cyberpunk glow, word-by-word ────────────────────────────────
  neon: {
    label: 'Neon',
    desc:  'Word-by-word, electric cyan glow — cyberpunk feel',
    fontName:     'Arial Black',
    fontSize:     84,
    primaryColor: rgb(0,255,220),
    outlineColor: rgb(0,180,160),
    backColor:    rgba(0,0,0,0),
    bold:         true,
    outline:      3,
    shadow:       0,
    borderStyle:  1,
    spacing:      0,
    scaleX:       100,
    scaleY:       100,
    alignment:    2,
    marginV:      90,
    uppercase:    true,
    wordsPerLine: 1,
    renderMode:   'word',
    popIn:        true,
    slideUp:      false,
    blurIn:       true,
    fade:         [0, 40],
    preview: { bg:'#0a0a0a', color:'#00ffdc', outlineColor:'#00b4a0', text:'NEON', font:'Arial Black', bold:true, size:28 },
  },

  // ── 4. Cinematic — editorial slide-up, slow fade ─────────────────────────
  cinematic: {
    label: 'Cinematic',
    desc:  '3-word slide-up groups, off-white, slow elegant fade',
    fontName:     'Arial',
    fontSize:     68,
    primaryColor: rgb(240,235,225),
    outlineColor: rgba(0,0,0,0.6),
    backColor:    rgba(0,0,0,0),
    bold:         true,
    outline:      2,
    shadow:       4,
    borderStyle:  1,
    spacing:      4,
    scaleX:       100,
    scaleY:       100,
    alignment:    2,
    marginV:      110,
    uppercase:    true,
    wordsPerLine: 3,
    renderMode:   'group',
    popIn:        false,
    slideUp:      true,
    blurIn:       false,
    fade:         [250, 200],
    preview: { bg:'#000', color:'#f0ebe1', outlineColor:'rgba(0,0,0,.6)', text:'C I N E M A T I C', font:'Arial', bold:true, size:17, spacing:3 },
  },

  // ── 5. Fire — white text, orange-to-red glowing outline ──────────────────
  fire: {
    label: 'Fire',
    desc:  '2-word pop, white text with deep orange fire outline',
    fontName:     'Arial Black',
    fontSize:     88,
    primaryColor: rgb(255,255,255),
    outlineColor: rgb(255,80,0),
    shadowColor:  rgb(180,20,0),
    backColor:    rgba(0,0,0,0),
    bold:         true,
    outline:      5,
    shadow:       2,
    borderStyle:  1,
    spacing:      0,
    scaleX:       100,
    scaleY:       100,
    alignment:    2,
    marginV:      90,
    uppercase:    true,
    wordsPerLine: 2,
    renderMode:   'group',
    popIn:        true,
    slideUp:      false,
    blurIn:       false,
    fade:         [0, 0],
    preview: { bg:'#111', color:'#fff', outlineColor:'#ff5000', text:'FIRE 🔥', font:'Arial Black', bold:true, size:26 },
  },

  // ── 6. Pill — translucent dark pill behind 3 words ────────────────────────
  pill: {
    label: 'Pill',
    desc:  '3-word groups inside a dark translucent pill — clean & modern',
    fontName:     'Arial',
    fontSize:     72,
    primaryColor: rgb(255,255,255),
    outlineColor: rgba(0,0,0,0),
    backColor:    rgba(0,0,0,0.72),
    bold:         true,
    outline:      0,
    shadow:       0,
    borderStyle:  3,
    spacing:      1,
    scaleX:       100,
    scaleY:       100,
    alignment:    2,
    marginV:      70,
    uppercase:    false,
    wordsPerLine: 3,
    renderMode:   'group',
    popIn:        false,
    slideUp:      false,
    blurIn:       false,
    fade:         [80, 60],
    preview: { bg:'#111', color:'#fff', pill:true, text:'Pill Caption', font:'Arial', bold:true, size:20 },
  },

  // ── 7. Shadow3D — white text with deep coloured 3D shadow ─────────────────
  shadow3d: {
    label: 'Shadow 3D',
    desc:  '2-word pop, white text with deep purple 3D drop shadow',
    fontName:     'Arial Black',
    fontSize:     86,
    primaryColor: rgb(255,255,255),
    outlineColor: rgb(255,255,255),
    shadowColor:  rgb(80,0,140),
    backColor:    rgba(0,0,0,0),
    bold:         true,
    outline:      1.5,
    shadow:       7,
    borderStyle:  1,
    spacing:      0,
    scaleX:       100,
    scaleY:       100,
    alignment:    2,
    marginV:      90,
    uppercase:    true,
    wordsPerLine: 2,
    renderMode:   'group',
    popIn:        true,
    slideUp:      false,
    blurIn:       false,
    fade:         [0, 0],
    preview: { bg:'#111', color:'#fff', outlineColor:'transparent', shadow:'5px 5px 0 #50008c', text:'SHADOW 3D', font:'Arial Black', bold:true, size:24 },
  },

  // ── 8. Explainer — high-retention educational style ───────────────────────
  // Matches the "System Preset: High-Retention Educational Explainer" spec:
  // ALL CAPS, white base, bright yellow on active word (karaoke), 2 words per
  // group, heavy sans-serif, black drop-shadow, lower-middle positioning.
  explainer: {
    label: 'Explainer',
    desc:  '2-word karaoke, white + yellow active word — high-retention educational style',
    fontName:       'Arial Black',
    fontSize:       84,
    primaryColor:   rgb(255,255,255),
    highlightColor: rgb(255,221,0),   // bright yellow accent on the active word
    highlightScale: 108,              // active word scales up slightly
    outlineColor:   rgb(0,0,0),
    shadowColor:    rgb(0,0,0),
    backColor:      rgba(0,0,0,0),
    bold:           true,
    outline:        3,
    shadow:         4,                // black drop-shadow for readability
    borderStyle:    1,
    spacing:        0,
    scaleX:         100,
    scaleY:         100,
    alignment:      2,
    marginV:        100,              // lower-middle of frame
    uppercase:      true,
    wordsPerLine:   2,
    renderMode:     'karaoke',        // active word gets yellow highlight
    popIn:          true,             // clean pop-in per group
    slideUp:        false,
    blurIn:         false,
    fade:           [0, 0],
    preview: { bg:'#0d1b2e', color:'#fff', outlineColor:'#000', text:'WHITE <span style="color:#ffdd00">YELLOW</span>', font:'Arial Black', bold:true, size:24 },
  },

  // ── 9. Viral (#18) — word-by-word, pill highlight, colour-cycle ─────────────
  // Each word pops in solo with a coloured pill background; cycling through
  // brand accent colours every 4 words. Maximum engagement / lowest skip rate.
  viral: {
    label: 'Viral',
    desc:  'One word at a time, pill bg per word — maximum engagement style',
    fontName:       'Arial Black',
    fontSize:       90,
    primaryColor:   rgb(255,255,255),
    highlightColor: rgb(255,214,0),    // rotating accent
    highlightScale: 110,
    outlineColor:   rgba(0,0,0,0),
    backColor:      rgba(15,15,15,0.82),
    bold:           true,
    outline:        0,
    shadow:         0,
    borderStyle:    3,                 // opaque box (pill)
    spacing:        2,
    scaleX:         105,
    scaleY:         105,
    alignment:      2,
    marginV:        80,
    uppercase:      true,
    wordsPerLine:   1,
    renderMode:     'word',
    popIn:          true,
    slideUp:        true,
    blurIn:         false,
    fade:           [0, 30],
    // Colour palette rotated across consecutive words for variety
    colorCycle:     [
      rgb(255,214,0),   // gold
      rgb(0,220,180),   // teal
      rgb(255,80,120),  // pink-red
      rgb(120,180,255), // sky blue
    ],
    preview: { bg:'#111', color:'#fff', pill:true, pillColor:'#ffda00', text:'ONE WORD', font:'Arial Black', bold:true, size:28 },
  },
};

// ── ASS time format ────────────────────────────────────────────────────────────
function fmtAss(seconds) {
  const s  = Math.max(0, seconds);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

// ── Group words into timed caption chunks ──────────────────────────────────────
function groupWords(words, wordsPerLine) {
  const raw = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const chunk = words.slice(i, i + wordsPerLine);
    if (!chunk.length) continue;
    raw.push({
      words: chunk,
      start: chunk[0].start,
      end:   chunk[chunk.length - 1].end,
      text:  chunk.map(w => w.word).join(' '),
    });
  }

  // Fix overlapping / too-short end times so ASS never renders two events at once.
  const GAP     = 0.08; // 80 ms hard gap between groups — large enough to survive timestamp jitter
  const MIN_DUR = 0.12; // every group must show for at least 120 ms
  for (let i = 0; i < raw.length; i++) {
    // Enforce minimum display duration
    raw[i].end = Math.max(raw[i].end, raw[i].start + MIN_DUR);

    if (i < raw.length - 1) {
      const nextStart = raw[i + 1].start;
      // Always clamp end to strictly before next start
      raw[i].end = Math.min(raw[i].end, nextStart - GAP);
      // After clamping, re-apply minimum duration (may push end forward slightly,
      // but that only matters if groups are extremely close — still < next start)
      if (raw[i].end < raw[i].start + MIN_DUR) {
        raw[i].end = Math.min(raw[i].start + MIN_DUR, nextStart - GAP * 0.5);
      }
    }
  }

  return raw;
}

// ── Build the opening animation override tags for a dialogue event ─────────────
// Returns inline ASS tags (before the text) that produce the entry animation.
function animationTags(tmpl, cx, cy) {
  const tags = [];

  if (tmpl.popIn) {
    // Pop-in: scale 78% → 106% → 100% (overshoot bounce in 160ms)
    tags.push(`{\\fscx78\\fscy78\\t(0,90,\\fscx106\\fscy106)\\t(90,160,\\fscx100\\fscy100)}`);
  }

  if (tmpl.slideUp) {
    // Slide up 22px over 110ms from below
    tags.push(`{\\pos(${cx},${cy + 22})\\t(0,110,\\pos(${cx},${cy}))}`);
  } else if (cx !== undefined) {
    // Fixed position (needed when not using marginV so libass doesn't re-calc)
    // Only inject \pos when we need it for slideUp; otherwise let style margins work.
  }

  if (tmpl.blurIn) {
    // Start blurry, sharpen over 140ms
    tags.push(`{\\blur8\\t(0,140,\\blur0)}`);
  }

  if (tmpl.fade[0] > 0 || tmpl.fade[1] > 0) {
    tags.push(`{\\fad(${tmpl.fade[0]},${tmpl.fade[1]})}`);
  }

  // Merge all tags into one block
  if (!tags.length) return '';
  // Strip outer {} and rejoin as single block
  return '{' + tags.map(t => t.slice(1, -1)).join('') + '}';
}

// ── Build the full ASS subtitle file ──────────────────────────────────────────
function buildAss(words, tmpl, playResX = 1920, playResY = 1080) {
  const t = tmpl;

  // Position for bottom-center anchor (alignment 2)
  const cx = Math.round(playResX / 2);
  const cy = playResY - t.marginV;

  // Shadow colour override — some templates specify a custom shadowColor
  const shadowColorTag = t.shadowColor ? `\\4c${t.shadowColor}` : '';

  const header = `[Script Info]
Title: Captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: ${playResX}
PlayResY: ${playResY}
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${t.fontName},${t.fontSize},${t.primaryColor},${t.primaryColor},${t.outlineColor},${t.backColor},${t.bold ? -1 : 0},0,0,0,${t.scaleX},${t.scaleY},${t.spacing},0,${t.borderStyle},${t.outline},${t.shadow},${t.alignment},20,20,${t.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = [];

  // ── Helper: emit one dialogue line ────────────────────────────────────────
  function emit(layer, start, end, text, extraTags = '') {
    // For slideUp we need \pos so it can be animated; everything else uses style margins
    const posTags = t.slideUp ? `{\\pos(${cx},${cy})${extraTags ? extraTags.slice(1,-1) : ''}}` : extraTags;
    events.push(`Dialogue: ${layer},${fmtAss(start)},${fmtAss(end)},Default,,20,20,${t.marginV},,${posTags}${text}`);
  }

  // ── Render modes ──────────────────────────────────────────────────────────
  if (t.renderMode === 'word') {
    // One word at a time — with optional color-cycle (viral template, #18)
    const cycle = t.colorCycle || null;
    for (let wi = 0; wi < words.length; wi++) {
      const w    = words[wi];
      const txt  = t.uppercase ? w.word.toUpperCase() : w.word;
      const anim = animationTags(t, cx, cy);
      const shadow = shadowColorTag ? `{${shadowColorTag}}` : '';
      const colorTag = cycle
        ? `{\\c${cycle[wi % cycle.length]}}`
        : '';
      emit(0, w.start, w.end, shadow + colorTag + anim + txt);
    }

  } else if (t.renderMode === 'karaoke') {
    // N-word groups; one event per word showing the full group.
    // Active word is bigger + coloured; others are white.
    const groups = groupWords(words, t.wordsPerLine);
    for (const group of groups) {
      for (let wi = 0; wi < group.words.length; wi++) {
        const activeWord = group.words[wi];
        const anim = animationTags(t, cx, cy);

        // Build phrase: each word individually tagged
        const phrase = group.words.map((w, j) => {
          const txt = t.uppercase ? w.word.toUpperCase() : w.word;
          if (j === wi) {
            // Active word: highlight color + scale up
            const scale = t.highlightScale || 110;
            return `{\\c${t.highlightColor}\\fscx${scale}\\fscy${scale}}${txt}{\\r}`;
          }
          return txt;
        }).join(' ');

        emit(0, activeWord.start, activeWord.end, anim + phrase);
      }
    }

  } else {
    // 'group' mode — N words at once
    const groups = groupWords(words, t.wordsPerLine);
    for (const group of groups) {
      const txt  = t.uppercase ? group.text.toUpperCase() : group.text;
      const anim = animationTags(t, cx, cy);
      const shadow = shadowColorTag ? `{${shadowColorTag}}` : '';
      emit(0, group.start, group.end, shadow + anim + txt);
    }
  }

  return `${header}\n${events.join('\n')}`;
}

// ── Groq Whisper transcription with key rotation ───────────────────────────────
async function transcribeWithGroq(audioPath, apiKeys, logger) {
  const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys].filter(Boolean);
  if (!keys.length) throw new Error('No Groq API key available for transcription');

  const MAX_BYTES = 24 * 1024 * 1024;
  let uploadPath = audioPath;

  const stat = fs.statSync(audioPath);
  if (stat.size > MAX_BYTES) {
    logger.log(`⚠️  Audio ${(stat.size / 1048576).toFixed(1)} MB > 24 MB — compressing…`);
    const compressed = audioPath.replace(/\.\w+$/, '_c.mp3');
    await execAsync(`ffmpeg -y -i "${audioPath}" -ac 1 -ar 16000 -b:a 32k "${compressed}"`, { timeout: 120_000 });
    uploadPath = compressed;
    if (fs.statSync(uploadPath).size > MAX_BYTES) throw new Error('Audio still >24 MB after compression. Try a shorter clip.');
  }

  const buf  = fs.readFileSync(uploadPath);
  const mime = uploadPath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
  logger.log(`🎤 Sending ${(buf.length / 1048576).toFixed(1)} MB to Groq Whisper large-v3…`);

  let lastErr;
  for (let ki = 0; ki < keys.length; ki++) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: mime }), path.basename(uploadPath));
      fd.append('model', 'whisper-large-v3');
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word');
      fd.append('language', 'en');

      if (ki > 0) logger.log(`   Retrying with key ${ki + 1}/${keys.length}…`);

      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method:  'POST',
        headers: { Authorization: `Bearer ${keys[ki]}` },
        body:    fd,
        signal:  AbortSignal.timeout(240_000),
      });

      if (!r.ok) {
        const errTxt = await r.text().catch(() => r.statusText);
        const e = new Error(`Groq Whisper ${r.status}: ${errTxt.slice(0, 300)}`);
        e.status = r.status;
        throw e;
      }

      const data = await r.json();
      logger.log(`✅ Transcription — ${data.words?.length ?? 0} words, ${(data.duration ?? 0).toFixed(1)}s`);

      // Synthesise word timestamps from segments if missing
      if (!data.words?.length && data.segments?.length) {
        logger.log('⚠️  No word timestamps — synthesising from segments…');
        const words = [];
        for (const seg of data.segments) {
          const ws = seg.text.trim().split(/\s+/).filter(Boolean);
          if (!ws.length) continue;
          const dur = (seg.end - seg.start) / ws.length;
          ws.forEach((w, i) => words.push({
            word:  w,
            start: +(seg.start + i * dur).toFixed(3),
            end:   +(seg.start + (i + 1) * dur).toFixed(3),
          }));
        }
        data.words = words;
      }

      return data;
    } catch (err) {
      lastErr = err;
      if (err.status === 429 && ki < keys.length - 1) {
        logger.log(`   ⚠️  Key ${ki + 1} rate-limited — next key…`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── Detect video resolution ────────────────────────────────────────────────────
async function getVideoSize(videoPath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${videoPath}"`,
      { timeout: 15_000 }
    );
    const [w, h] = stdout.trim().split('x').map(Number);
    if (w > 0 && h > 0) return { w, h };
  } catch(_) {}
  return { w: 1920, h: 1080 };
}

// ── Escape path for FFmpeg filter graph ────────────────────────────────────────
function escapeAssPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// ── Main: transcribe + burn captions ──────────────────────────────────────────
async function burnCaptions(videoPath, outputPath, templateId = 'impact', apiKeys, logger) {
  const tmpl = TEMPLATES[templateId] || TEMPLATES.impact;
  logger.log(`🎨 Caption template: ${tmpl.label} [${tmpl.renderMode} mode]`);

  const tmpDir = path.join(os.tmpdir(), `caps_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Extract audio
    const audioPath = path.join(tmpDir, 'audio.wav');
    logger.log('🔊 Extracting audio…');
    try {
      await execAsync(
        `ffmpeg -y -i "${videoPath}" -vn -ac 1 -ar 16000 -sample_fmt s16 -f wav "${audioPath}"`,
        { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }
      );
    } catch (e) {
      throw new Error(`Audio extraction failed: ${(e.stderr || e.message).slice(-400)}`);
    }

    if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
      throw new Error('Audio extraction produced an empty file — does the video have an audio track?');
    }
    logger.log(`   Audio: ${(fs.statSync(audioPath).size / 1048576).toFixed(1)} MB`);

    // 2. Transcribe
    const transcription = await transcribeWithGroq(audioPath, apiKeys, logger);
    if (!transcription.words?.length) {
      throw new Error('Transcription returned no words. Check that the video has clear speech.');
    }

    // 3. Detect video resolution
    const { w, h } = await getVideoSize(videoPath);
    logger.log(`   Video: ${w}×${h}`);

    // 4. Scale template values for portrait vs landscape.
    //    Portrait (9:16) is taller — push captions higher and scale font if needed.
    const isPortrait = h > w;
    const scaledTmpl = isPortrait ? {
      ...tmpl,
      // Slightly larger font on portrait (more vertical room)
      fontSize: Math.round(tmpl.fontSize * 1.05),
      // More space from bottom on portrait (phone safe area)
      marginV: Math.round(tmpl.marginV * 1.8),
    } : tmpl;

    const assContent = buildAss(transcription.words, scaledTmpl, w, h);
    const assPath    = path.join(tmpDir, 'captions.ass');
    fs.writeFileSync(assPath, assContent, 'utf8');
    logger.log(`📝 ASS file written (${assContent.split('\n').length} lines)`);

    // 5. Burn captions
    logger.log('🔥 Burning captions…');
    const escapedAss = escapeAssPath(assPath);
    const cmd = [
      'ffmpeg', '-y',
      `-i "${videoPath}"`,
      `-vf "ass='${escapedAss}'"`,
      '-c:v libx264 -preset fast -crf 18',
      '-c:a copy -movflags +faststart',
      `"${outputPath}"`,
    ].join(' ');

    try {
      await execAsync(cmd, { maxBuffer: 200 * 1024 * 1024, timeout: 900_000 });
    } catch (e) {
      throw new Error(`FFmpeg burn failed:\n${(e.stderr || e.message).slice(-800)}`);
    }

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('FFmpeg produced an empty output file');
    }
    logger.log(`✅ Captions burned — ${(fs.statSync(outputPath).size / 1048576).toFixed(1)} MB`);

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
  }
}

module.exports = { burnCaptions, TEMPLATES };
