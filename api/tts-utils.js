// Shared TTS preprocessing utilities used by both server.js (/api/tts) and scheduler.js.

// ── Text cleaning (shared core) ───────────────────────────────────────────────
function _cleanText(raw) {
  let t = raw;

  // 1. Remove stage directions the LLM sometimes sneaks in
  t = t.replace(/\[(?:pause|beat|cut|silence|music|sfx|transition)[^\]]*\]/gi, ‘’);
  t = t.replace(/\((?:pause|beat|silence|music)[^)]*\)/gi, ‘’);

  // 2. Strip markdown formatting
  t = t.replace(/\*\*(.+?)\*\*/g, ‘$1’);           // **bold**
  t = t.replace(/\*(.+?)\*/g, ‘$1’);                // *italic*
  t = t.replace(/__(.+?)__/g, ‘$1’);                // __underline__
  t = t.replace(/_(.+?)_/g, ‘$1’);                  // _italic_
  t = t.replace(/#{1,6}\s*/g, ‘’);                  // ## headings
  t = t.replace(/`{1,3}[^`]*`{1,3}/g, ‘’);         // `code`
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, ‘$1’);   // [link](url) → link text
  t = t.replace(/https?:\/\/\S+/g, ‘’);            // bare URLs

  // 3. Em-dash / en-dash → natural pause
  t = t.replace(/ — /g, ‘... ‘);
  t = t.replace(/—/g, ‘... ‘);
  t = t.replace(/–/g, ‘, ‘);
  t = t.replace(/…/g, ‘... ‘);

  // 4. Typographic quotes → straight ASCII
  t = t.replace(/[‘’]/g, “’”);
  t = t.replace(/[“”]/g, ‘”’);

  // 5. Bullet / list symbols → sentence break
  t = t.replace(/·|•|●|▪|►|→/g, ‘. ‘);
  t = t.replace(/^\s*\d+\.\s+/gm, ‘’);   // numbered list items
  t = t.replace(/^\s*[-–•]\s+/gm, ‘’);   // dashed / bulleted list items

  // 6. Symbols → spoken words
  t = t.replace(/(\d[\d,]*\.?\d*)\s*%/g, ‘$1 percent’);
  t = t.replace(/\$(\d[\d,]*\.?\d*)/g,   ‘$1 dollars’);
  t = t.replace(/£(\d[\d,]*\.?\d*)/g,    ‘$1 pounds’);
  t = t.replace(/€(\d[\d,]*\.?\d*)/g,    ‘$1 euros’);
  t = t.replace(/&/g,    ‘ and ‘);
  t = t.replace(/\+/g,   ‘ plus ‘);
  t = t.replace(/#(\w+)/g, ‘$1’);    // #hashtag → hashtag
  t = t.replace(/@(\w+)/g, ‘$1’);    // @mention → mention

  // 7. Common abbreviations → spoken forms
  t = t.replace(/\betc\.\s*/gi,  ‘et cetera. ‘);
  t = t.replace(/\be\.g\.\s*/gi, ‘for example, ‘);
  t = t.replace(/\bi\.e\.\s*/gi, ‘that is, ‘);
  t = t.replace(/\bvs\.\s*/gi,   ‘versus ‘);
  t = t.replace(/\bDr\.\s+/g,    ‘Doctor ‘);
  t = t.replace(/\bMr\.\s+/g,    ‘Mister ‘);
  t = t.replace(/\bMrs\.\s+/g,   ‘Missus ‘);
  t = t.replace(/\bMs\.\s+/g,    ‘Miss ‘);
  t = t.replace(/\bSt\.\s+/g,    ‘Saint ‘);
  t = t.replace(/\bApr\.\s*/gi,  ‘April ‘);
  t = t.replace(/\bAug\.\s*/gi,  ‘August ‘);
  t = t.replace(/\bDec\.\s*/gi,  ‘December ‘);
  t = t.replace(/\bFeb\.\s*/gi,  ‘February ‘);
  t = t.replace(/\bJan\.\s*/gi,  ‘January ‘);
  t = t.replace(/\bJul\.\s*/gi,  ‘July ‘);
  t = t.replace(/\bJun\.\s*/gi,  ‘June ‘);
  t = t.replace(/\bMar\.\s*/gi,  ‘March ‘);
  t = t.replace(/\bNov\.\s*/gi,  ‘November ‘);
  t = t.replace(/\bOct\.\s*/gi,  ‘October ‘);
  t = t.replace(/\bSep\.\s*/gi,  ‘September ‘);

  // 8. Ordinal numbers → spoken words (1st → first … 20th → twentieth)
  const ordinals = {
    ‘1st’:’first’,’2nd’:’second’,’3rd’:’third’,’4th’:’fourth’,’5th’:’fifth’,
    ‘6th’:’sixth’,’7th’:’seventh’,’8th’:’eighth’,’9th’:’ninth’,’10th’:’tenth’,
    ‘11th’:’eleventh’,’12th’:’twelfth’,’13th’:’thirteenth’,’14th’:’fourteenth’,
    ‘15th’:’fifteenth’,’16th’:’sixteenth’,’17th’:’seventeenth’,’18th’:’eighteenth’,
    ‘19th’:’nineteenth’,’20th’:’twentieth’,
  };
  t = t.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, (m, n, s) => ordinals[(n + s).toLowerCase()] || m);

  // 9. Small integers (1–20) written as digits → words
  const nums = [‘zero’,’one’,’two’,’three’,’four’,’five’,’six’,’seven’,’eight’,’nine’,
                 ‘ten’,’eleven’,’twelve’,’thirteen’,’fourteen’,’fifteen’,’sixteen’,
                 ‘seventeen’,’eighteen’,’nineteen’,’twenty’];
  t = t.replace(/\b(\d{1,2})\b/g, (m, n) => {
    const i = parseInt(n, 10);
    return (i <= 20 && nums[i]) ? nums[i] : m;
  });

  // 10. Tidy whitespace and stray punctuation artefacts
  t = t.replace(/[ \t]{2,}/g, ‘ ‘);           // multiple spaces → one
  t = t.replace(/\n{3,}/g, ‘\n\n’);           // max double newline
  t = t.replace(/([.!?])\s*([.!?])+/g, ‘$1’); // duplicate end-punctuation
  t = t.replace(/,\s*,/g, ‘,’);               // double commas
  t = t.replace(/\(\s*\)/g, ‘’);              // empty parens
  t = t.replace(/\.\s*\.\s*\./g, ‘...’);      // normalise ellipsis spacing

  return t.trim();
}

// ── Plain-text preprocessor (OmniVoice / OpenAI-compatible APIs) ──────────────
// OmniVoice does not support SSML. Pauses are induced via punctuation cues that
// the neural model’s prosody engine responds to: “...” (~400 ms breath pause)
// and “, “ with a trailing soft-pause marker for commas (~200 ms).
function preprocessTTS(raw) {
  let t = _cleanText(raw);

  // Sentence-ending punctuation → append ellipsis pause cue (~400 ms breath)
  // Avoid doubling up where “...” already exists from step 3 above.
  t = t.replace(/([.!?])(?!\.)(\s)/g, ‘$1... $2’);

  // Comma → light pause cue (~200 ms)
  t = t.replace(/,(\s)/g, ‘,.. $1’);

  // Final whitespace tidy after pause injections
  t = t.replace(/[ \t]{2,}/g, ‘ ‘);

  return t.trim();
}

// ── SSML preprocessor (for APIs that accept <speak> markup) ──────────────────
// Use this instead of preprocessTTS when sending to a TTS engine that supports
// SSML (e.g. Google TTS, Amazon Polly, Azure Cognitive Speech).
// Wraps the output in a <speak> root element and appends explicit <break> tags:
//   <break time=”400ms”/> after sentence-ending punctuation (. ! ?)
//   <break time=”200ms”/> after commas
function preprocessTTSWithSSML(raw) {
  let t = _cleanText(raw);

  // Escape XML special characters before injecting markup
  t = t.replace(/&/g, ‘&amp;’);
  t = t.replace(/</g, ‘&lt;’);
  t = t.replace(/>/g, ‘&gt;’);
  t = t.replace(/”/g, ‘&quot;’);

  // Inject <break> after sentence-ending punctuation
  t = t.replace(/([.!?])(?!\.)(\s|$)/g, ‘$1<break time=”400ms”/>$2’);

  // Inject <break> after commas
  t = t.replace(/,(\s)/g, ‘,<break time=”200ms”/>$1’);

  return `<speak>${t}</speak>`;
}

// ── Chunking ──────────────────────────────────────────────────────────────────
// Splits cleaned text into natural paragraph/sentence chunks.
// Chunks tagged with isParagraphBreak=true get silence inserted after them.
// Smaller maxChars (300) gives better prosody than 480.
function chunkTTS(text, maxChars = 300) {
  const paras = text.split(/\n{2,}/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const chunks = [];

  for (let pi = 0; pi < paras.length; pi++) {
    const para = paras[pi];
    const isLast = pi === paras.length - 1;

    if (para.length <= maxChars) {
      chunks.push({ text: para, paragraphEnd: !isLast });
      continue;
    }
    // Split long paragraph at sentence boundaries
    const sentences = para.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [para];
    let current = '';
    for (let si = 0; si < sentences.length; si++) {
      const s = sentences[si];
      const isLastSentence = si === sentences.length - 1;
      if ((current + ' ' + s).trim().length > maxChars && current.length > 0) {
        chunks.push({ text: current.trim(), paragraphEnd: false });
        current = s;
      } else {
        current = (current + ' ' + s).trim();
      }
      if (isLastSentence && current.trim()) {
        chunks.push({ text: current.trim(), paragraphEnd: !isLast });
        current = '';
      }
    }
    if (current.trim()) chunks.push({ text: current.trim(), paragraphEnd: !isLast });
  }

  return chunks.length > 0 ? chunks : [{ text, paragraphEnd: false }];
}

// ── WAV silence generator ─────────────────────────────────────────────────────
// Generates a minimal valid WAV buffer of silence at the given sample rate.
// Used to inject breathing room between paragraph chunks.
function silenceWav(durationMs, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const numSamples   = Math.floor((sampleRate * durationMs) / 1000) * channels;
  const dataBytes    = numSamples * (bitDepth / 8);
  const headerBytes  = 44;
  const buf          = Buffer.alloc(headerBytes + dataBytes, 0);

  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);

  // fmt chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16,         16); // chunk size
  buf.writeUInt16LE(1,          20); // PCM
  buf.writeUInt16LE(channels,   22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28); // byte rate
  buf.writeUInt16LE(channels * (bitDepth / 8), 32);              // block align
  buf.writeUInt16LE(bitDepth,   34);

  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  // remaining bytes are already 0 (silence)

  return buf;
}

// ── FFmpeg filter_complex audio stitcher ──────────────────────────────────────
// Builds an explicit multi-input filter graph:
//   [0:a][1:a]...[N-1:a]concat=n=N:v=0:a=1[aout]
// Silence padding is interleaved as real WAV input files so every stream keeps
// its literal [i:a] label and the concat receives exactly N sequential inputs.
// Output is re-encoded to broadcast-safe MP3: 44100 Hz / stereo / 192k.
//
// paragraphBreakMs : gap after a paragraph-end chunk  (default 350 ms)
// sentenceBreakMs  : gap between sentence chunks       (default  80 ms)
async function stitchWavWithFfmpeg(buffers, paragraphBreakMs = 350, sentenceBreakMs = 80) {
  if (buffers.length === 0) throw new Error('No audio buffers to stitch');

  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const { runFfmpeg } = require('./ffmpeg');

  const tmpDir = path.join(os.tmpdir(), `tts_stitch_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // ── Write speech chunk files ─────────────────────────────────────────────
    const chunkPaths = buffers.map((item, i) => {
      const p = path.join(tmpDir, `chunk_${i}.wav`);
      fs.writeFileSync(p, item.buf);
      return p;
    });

    const outputPath = path.join(tmpDir, 'stitched.mp3');
    const inputArgs  = chunkPaths.flatMap(p => ['-i', p]);

    // ── Build filter_complex ─────────────────────────────────────────────────
    // Speech chunks arrive as file inputs [0:a]..[N-1:a].
    // Silence between chunks is generated inline via anullsrc — no temp files.
    //
    // For N speech chunks the filter produces 2N-1 streams:
    //   chunk_0, silence_0, chunk_1, silence_1, ..., chunk_N-1
    //
    // Each silence node:
    //   anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=D[sI]
    //
    // Final concat:
    //   [0:a][s0][1:a][s1]...[N-1:a]concat=n=(2N-1):v=0:a=1[aout]
    const N = buffers.length;
    const filterParts   = [];
    const concatStreams = [];

    for (let i = 0; i < N; i++) {
      concatStreams.push(`[${i}:a]`);

      if (i < N - 1) {
        const gapSec = ((buffers[i].paragraphEnd ? paragraphBreakMs : sentenceBreakMs) / 1000).toFixed(3);
        filterParts.push(
          `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${gapSec}[s${i}]`
        );
        concatStreams.push(`[s${i}]`);
      }
    }

    const totalStreams   = concatStreams.length; // N chunks + (N-1) silence nodes
    const concatFilter  = `${concatStreams.join('')}concat=n=${totalStreams}:v=0:a=1[aout]`;
    filterParts.push(concatFilter);

    await runFfmpeg([
      '-y',
      ...inputArgs,
      '-filter_complex', filterParts.join(';'),
      '-map',  '[aout]',
      '-ar',   '44100',
      '-ac',   '2',
      '-c:a',  'libmp3lame',
      '-b:a',  '192k',
      outputPath,
    ], { timeoutMs: 120_000 });

    return fs.readFileSync(outputPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── WAV stitcher (legacy synchronous fallback) ────────────────────────────────
// Used as a last-resort fallback if ffmpeg is unavailable. Concatenates raw PCM
// data using the first chunk's header — will glitch if formats differ.
function stitchWavBuffers(buffers, paragraphBreakMs = 350, sentenceBreakMs = 80) {
  if (buffers.length === 0) throw new Error('No WAV buffers to stitch');
  if (buffers.length === 1) return buffers[0].buf;

  const sampleRate = buffers[0].buf.readUInt32LE(24);
  const channels   = buffers[0].buf.readUInt16LE(22);
  const bitDepth   = buffers[0].buf.readUInt16LE(34);

  for (let i = 1; i < buffers.length; i++) {
    const sr = buffers[i].buf.readUInt32LE(24);
    const ch = buffers[i].buf.readUInt16LE(22);
    const bd = buffers[i].buf.readUInt16LE(34);
    if (sr !== sampleRate || ch !== channels || bd !== bitDepth) {
      console.warn(`⚠️  Audio format mismatch in chunk ${i}: expected ${sampleRate}Hz/${channels}ch/${bitDepth}bit, got ${sr}Hz/${ch}ch/${bd}bit — use stitchWavWithFfmpeg to avoid glitches`);
    }
  }

  const pcmParts = [];
  for (let i = 0; i < buffers.length; i++) {
    const { buf, paragraphEnd } = buffers[i];
    pcmParts.push(buf.slice(findDataOffset(buf)));
    if (i < buffers.length - 1) {
      const gapMs = paragraphEnd ? paragraphBreakMs : sentenceBreakMs;
      pcmParts.push(silenceWav(gapMs, sampleRate, channels, bitDepth).slice(44));
    }
  }

  const pcm       = Buffer.concat(pcmParts);
  const totalData = pcm.length;
  const firstOffset = findDataOffset(buffers[0].buf);
  const header = Buffer.from(buffers[0].buf.slice(0, firstOffset));
  const out    = Buffer.concat([header, pcm]);
  out.writeUInt32LE(firstOffset - 8 + totalData, 4);
  out.writeUInt32LE(totalData, firstOffset - 4);
  return out;
}

function findDataOffset(buf) {
  for (let i = 12; i < buf.length - 8; i++) {
    if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61) {
      return i + 8;
    }
  }
  return 44;
}

module.exports = { preprocessTTS, preprocessTTSWithSSML, chunkTTS, silenceWav, stitchWavBuffers, stitchWavWithFfmpeg, findDataOffset };
