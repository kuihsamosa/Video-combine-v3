const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const pdfParse = require('pdf-parse');

const execAsync = promisify(exec);

const ANNOTATION_CONFIG = {
  tempDir: path.join(__dirname, '../temp'),
  outputDir: path.join(__dirname, '../output')
};

function ensureAnnotationDirs() {
  [ANNOTATION_CONFIG.tempDir, ANNOTATION_CONFIG.outputDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

  });
}

function normalizeLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyPageNumber(line) {
  const s = normalizeLine(line);
  if (!s) return false;
  if (/^\d{1,4}$/.test(s)) return true;
  if (/^page\s*\d{1,4}(\s*of\s*\d{1,4})?$/i.test(s)) return true;
  return false;
}

function stripStrayArtifacts(text) {
  if (!text) return '';
  return text
    // Common PDF extraction garbage
    .replace(/\(cid:\d+\)/g, '')
    .replace(/\[\s*figure[^\]]*\]/gi, '')
    .replace(/\[\s*table[^\]]*\]/gi, '')
    .replace(/\uf0b7/g, '')
    .replace(/\u2022/g, '')
    .replace(/\u25cf/g, '')
    .replace(/\u25aa/g, '')
    .replace(/\u25a0/g, '')
    .replace(/\u00b7/g, '')
    .replace(/[•●▪■]+/g, '')
    .replace(/\s{2,}/g, ' ');
}

function cleanPdfText(rawText) {
  if (!rawText) return '';

  // Normalize newlines early
  let text = String(rawText).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // De-hyphenate words split across line breaks: envi-\nronment => environment
  text = text.replace(/([A-Za-z])\-\n([A-Za-z])/g, '$1$2');

  // pdf-parse usually separates pages with form feed
  const pages = text.split(/\f+/).map(p => p.trim()).filter(Boolean);
  if (pages.length === 0) {
    text = stripStrayArtifacts(text);
    return text
      .split(/\n{2,}/)
      .map(block => block.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  // Build frequency map for candidate headers/footers across pages
  const headerCounts = new Map();
  const footerCounts = new Map();
  const headerSampleCount = 2;
  const footerSampleCount = 2;

  const pageLines = pages.map(p => p.split('\n').map(l => l.trim()));
  for (const lines of pageLines) {
    const head = lines.slice(0, headerSampleCount).map(normalizeLine).filter(Boolean);
    const foot = lines.slice(Math.max(0, lines.length - footerSampleCount)).map(normalizeLine).filter(Boolean);
    head.forEach(l => headerCounts.set(l, (headerCounts.get(l) || 0) + 1));
    foot.forEach(l => footerCounts.set(l, (footerCounts.get(l) || 0) + 1));
  }

  const threshold = Math.max(2, Math.ceil(pageLines.length * 0.6));
  const repeatedHeaders = new Set(
    [...headerCounts.entries()]
      .filter(([line, count]) => count >= threshold && line.length >= 3)
      .map(([line]) => line)
  );
  const repeatedFooters = new Set(
    [...footerCounts.entries()]
      .filter(([line, count]) => count >= threshold && line.length >= 3)
      .map(([line]) => line)
  );

  const cleanedPages = pageLines.map(lines => {
    const out = [];
    for (const line of lines) {
      const n = normalizeLine(line);
      if (!n) {
        out.push('');
        continue;
      }
      if (isLikelyPageNumber(n)) continue;
      if (repeatedHeaders.has(n)) continue;
      if (repeatedFooters.has(n)) continue;

      // Remove bullet / numbering prefixes that come from layout
      const withoutPrefix = n
        .replace(/^(?:[•●▪■\-–—]+)\s*/g, '')
        .replace(/^\(?\d+\)?[\.)]\s+/g, '')
        .replace(/^[A-Za-z]\)[\s]+/g, '');

      const stripped = stripStrayArtifacts(withoutPrefix).trim();
      if (!stripped) continue;
      out.push(stripped);
    }
    return out.join('\n');
  });

  // Consolidate paragraphs: join wrapped lines inside a paragraph.
  const merged = cleanedPages
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n');

  const paragraphs = merged
    .split(/\n{2,}/)
    .map(p => p.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return paragraphs.join('\n\n');
}


async function probeDurationSeconds(inputPath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
  );
  const dur = parseFloat(stdout.trim());
  return Number.isFinite(dur) ? dur : 0;
}

function generateMockAnnotations(durationSeconds) {
  const annotations = [];
  const beats = Math.max(3, Math.min(12, Math.floor(durationSeconds / 6)));
  const effects = [
    { label: 'Pop-in title', style: 'glass' },
    { label: 'Lower-third swipe', style: 'neon' },
    { label: 'Kinetic caption', style: 'bold' },
    { label: 'Luma wipe', style: 'matte' },
    { label: 'Shape burst', style: 'vibrant' },
    { label: 'Glow pulse', style: 'aura' }
  ];

  for (let i = 0; i < beats; i++) {
    const start = Math.max(0, (durationSeconds / beats) * i);
    const end = Math.min(durationSeconds, start + Math.max(1.2, durationSeconds / (beats + 1)));
    const effect = effects[i % effects.length];
    annotations.push({
      id: `ann_${i + 1}`,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      text: `${effect.label} #${i + 1}`,
      style: effect.style,
      intensity: ['soft', 'medium', 'bold'][i % 3]
    });
  }

  return annotations;
}

async function extractAudioToWav(inputPath, outputPath) {
  await execAsync(
    `ffmpeg -y -i "${inputPath}" -vn -ac 1 -ar 16000 -f wav "${outputPath}"`
  );
  return outputPath;
}

async function transcribeWithWhisper(audioPath) {
  // Runs a local Python one-liner using faster-whisper if available.
  // Returns [{ start, end, text }]
  const pyCode = `
import json, sys
try:
    from faster_whisper import WhisperModel
except Exception as e:
    sys.stderr.write("missing faster-whisper\\\\n")
    sys.exit(3)
audio_path = sys.argv[1]
model = WhisperModel("small", device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio_path, beam_size=1, word_timestamps=False)
out = []
for seg in segments:
    out.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
print(json.dumps(out))
`;
  try {
    const { stdout } = await execAsync(`python3 - "${audioPath}" <<'PY'\n${pyCode}\nPY`, { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    console.error('Whisper transcription failed:', err.message);
  }
  return [];
}

function buildAnnotationsFromSegments(segments, durationSeconds) {
  const safeDuration = Number(durationSeconds) || 0;
  return segments
    .filter(s => s && typeof s.text === 'string' && s.text.trim())
    .map((seg, idx) => {
      const start = Math.max(0, Number(seg.start) || 0);
      let end = Math.max(start + 0.1, Number(seg.end) || start + 0.1);
      if (safeDuration > 0 && end > safeDuration) end = safeDuration;
      return {
        id: `whisper_${idx + 1}`,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        text: seg.text.trim(),
        style: 'hero',
        intensity: 'medium'
      };
    });
}

async function extractScriptText(pdfFilepath) {
  if (!pdfFilepath || !fs.existsSync(pdfFilepath)) return '';
  try {
    const dataBuffer = fs.readFileSync(pdfFilepath);
    const parsed = await pdfParse(dataBuffer);
    return cleanPdfText((parsed.text || '').trim());
  } catch (err) {
    return '';
  }
}

function buildAnnotationsFromText(text, durationSeconds) {
  if (!text) return generateMockAnnotations(durationSeconds);
  const sentences = text
    .split(/\n+/)
    .flatMap(p => p.split(/(?<=[.!?])\s+/))
    .map(s => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) return generateMockAnnotations(durationSeconds);

  const beats = sentences.length;
  const safeDuration = durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.max(durationSeconds, beats * 2.5)
    : beats * 3.5;
  const chunk = safeDuration / beats;
  const minDur = 2.5;
  const maxDur = 6.5;

  return sentences.map((line, idx) => {
    const start = Math.max(0, idx * chunk);
    const dur = Math.min(maxDur, Math.max(minDur, chunk * 0.9));
    const end = Math.min(safeDuration, start + dur);
    const styles = ['glass', 'neon', 'bold', 'matte', 'vibrant', 'aura'];
    return {
      id: `script_${idx + 1}`,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      text: line.slice(0, 180),
      style: styles[idx % styles.length],
      intensity: ['soft', 'medium', 'bold'][idx % 3]
    };
  });
}

async function handleAnnotation(req, res, { files, fields }, logger = console) {
  const log = (...args) => {
    if (logger && typeof logger.log === 'function') return logger.log(...args);
    return console.log(...args);
  };
  const error = (...args) => {
    if (logger && typeof logger.error === 'function') return logger.error(...args);
    return console.error(...args);
  };

  try {
    ensureAnnotationDirs();

    const video = files.video || files.file || files.videos;
    const scriptPdf = files.script_pdf;
    const videoFile = Array.isArray(video) ? video[0] : video;
    const scriptPdfFile = Array.isArray(scriptPdf) ? scriptPdf[0] : scriptPdf;

    if (!videoFile) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const originalName = videoFile.originalFilename || videoFile.filename || 'input.mp4';
    const ext = path.extname(originalName) || '.mp4';
    const sessionId = (fields.session_id && fields.session_id[0]) || Date.now().toString();
    const sessionDir = path.join(ANNOTATION_CONFIG.tempDir, `annot_${sessionId}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const inputPath = path.join(sessionDir, `annot_input${ext}`);
    fs.copyFileSync(videoFile.filepath, inputPath);
    const scriptPath = scriptPdfFile ? path.join(sessionDir, `script_${Date.now()}.pdf`) : null;
    if (scriptPdfFile) {
      fs.copyFileSync(scriptPdfFile.filepath, scriptPath);
    }

    log(`🎯 Annotation request for ${originalName}`);

    let durationSeconds = 0;
    try {
      durationSeconds = await probeDurationSeconds(inputPath);
      log(`Duration: ${durationSeconds.toFixed(2)}s`);
    } catch (durErr) {
      error('Duration probe failed:', durErr.message);
    }

    const scriptText = scriptPath ? await extractScriptText(scriptPath) : '';

    let annotations;
    if (scriptText) {
      annotations = buildAnnotationsFromText(scriptText, durationSeconds || 30);
    } else {
      // Attempt local ASR via faster-whisper; fallback to mock if unavailable.
      const audioPath = path.join(sessionDir, 'audio_tmp.wav');
      try {
        await extractAudioToWav(inputPath, audioPath);
        log(`🎤 Transcribing audio...`);
        const segments = await transcribeWithWhisper(audioPath);
        log(`🎤 Whisper returned ${segments.length} segments`);
        if (segments.length > 0) {
          log(`🎤 First segment: ${JSON.stringify(segments[0])}`);
          log(`🎤 Last segment: ${JSON.stringify(segments[segments.length - 1])}`);
          annotations = buildAnnotationsFromSegments(segments, durationSeconds);
          log(`🎤 Built ${annotations.length} annotations`);
        }
      } catch (asrErr) {
        error('ASR extraction failed:', asrErr.message);
      }
      if (!annotations || annotations.length === 0) {
        annotations = generateMockAnnotations(durationSeconds || 30);
      }
    }

    res.json({
      filename: originalName,
      duration: durationSeconds,
      annotations
    });

    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (e) {
    error('Annotation processing error:', e);
    res.status(500).json({
      error: 'Annotation generation failed',
      details: e.message
    });
  }
}

function formatTimestamp(seconds = 0) {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 100);
  return `${String(hrs).padStart(1, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

function buildAssFromAnnotations(annotations = [], title = 'Annotations') {
  const header = `[Script Info]
Title: ${title}
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.601

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Glass,Sora,10,&H00FFFFFF,&H00FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,1,1,1,2,20,20,20,1
Style: Neon,Sora,10,&H00FFFFFF,&H00FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,1,1,1,2,20,20,20,1
Style: Bold,Sora,10,&H00FFFFFF,&H00FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,1,1,1,2,20,20,20,1
Style: Matte,Sora,10,&H00FFFFFF,&H00FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,1,1,1,2,20,20,20,1
Style: Vibrant,Sora,10,&H00FFFFFF,&H00FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,1,1,1,2,20,20,20,1
Style: Aura,Sora,10,&H00FFFFFF,&H00FFFFFF,&H40000000,&H40000000,0,0,0,0,100,100,0,0,1,1,1,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const styleMap = {
    glass: { style: 'Glass', tag: '' },
    neon: { style: 'Neon', tag: '' },
    bold: { style: 'Bold', tag: '' },
    matte: { style: 'Matte', tag: '' },
    vibrant: { style: 'Vibrant', tag: '' },
    aura: { style: 'Aura', tag: '' }
  };
  const motionTag = '{\\fad(120,120)}';

  const lines = annotations.map((ann) => {
    const styleEntry = styleMap[ann.style] || styleMap.glass;
    const start = formatTimestamp(ann.start || 0);
    const end = formatTimestamp(ann.end || (ann.start || 0) + 2);
    const txt = (ann.text || '').replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${start},${end},${styleEntry.style},,40,40,30,,${motionTag}${styleEntry.tag}${txt}`;
  });

  return `${header}\n${lines.join('\n')}`;
}

async function handleAnnotationRender(req, res, { files, fields }, logger = console) {
  const log = (...args) => {
    if (logger && typeof logger.log === 'function') return logger.log(...args);
    return console.log(...args);
  };
  const error = (...args) => {
    if (logger && typeof logger.error === 'function') return logger.error(...args);
    return console.error(...args);
  };

  try {
    ensureAnnotationDirs();

    const video = files.video || files.file || files.videos;
    const videoFile = Array.isArray(video) ? video[0] : video;

    if (!videoFile) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const annotationsStr = (fields.annotations && (Array.isArray(fields.annotations) ? fields.annotations[0] : fields.annotations)) || null;
    if (!annotationsStr) {
      return res.status(400).json({ error: 'No annotations payload provided' });
    }

    let annotations;
    try {
      annotations = JSON.parse(annotationsStr);
    } catch (parseErr) {
      return res.status(400).json({ error: 'Invalid annotations JSON', details: parseErr.message });
    }

    if (!Array.isArray(annotations)) {
      return res.status(400).json({ error: 'Annotations must be an array' });
    }

    const originalName = videoFile.originalFilename || videoFile.filename || 'input.mp4';
    const ext = path.extname(originalName) || '.mp4';
    const sessionId = (fields.session_id && fields.session_id[0]) || Date.now().toString();
    const sessionDir = path.join(ANNOTATION_CONFIG.tempDir, `annot_render_${sessionId}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const inputPath = path.join(sessionDir, `annot_input${ext}`);
    fs.copyFileSync(videoFile.filepath, inputPath);

    // Build ASS file
    const assContent = buildAssFromAnnotations(annotations, originalName);
    const assPath = path.join(sessionDir, 'annotations.ass');
    fs.writeFileSync(assPath, assContent, 'utf8');

    const outputPath = path.join(ANNOTATION_CONFIG.outputDir, `annotated_${sessionId}.mp4`);
    const cmd = `ffmpeg -y -i "${inputPath}" -vf "ass=${assPath.replace(/'/g, "'\\''")}" -c:v libx264 -preset medium -crf 18 -c:a copy -movflags +faststart "${outputPath}"`;
    log(`[FFMPEG-ANNOTATE] Running: ${cmd}`);
    await execAsync(cmd);

    if (!fs.existsSync(outputPath)) {
      throw new Error('Annotated file not created');
    }
    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error('Annotated file is empty');
    }

    const buffer = fs.readFileSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="annotated.mp4"');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);

    fs.rmSync(sessionDir, { recursive: true, force: true });
    // leave output file on disk for reference
  } catch (e) {
    error('Annotation render error:', e);
    res.status(500).json({
      error: 'Annotation render failed',
      details: e.message
    });
  }
}

module.exports = { handleAnnotation, handleAnnotationRender };
