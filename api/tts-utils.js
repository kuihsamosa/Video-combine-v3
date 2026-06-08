// Shared TTS preprocessing utilities used by both server.js (/api/tts) and scheduler.js.

// ── Text cleaning ─────────────────────────────────────────────────────────────
function preprocessTTS(raw) {
  let t = raw;

  // 1. Remove stage directions the LLM sometimes sneaks in
  t = t.replace(/\[(?:pause|beat|cut|silence|music|sfx|transition)[^\]]*\]/gi, '');
  t = t.replace(/\((?:pause|beat|silence|music)[^)]*\)/gi, '');

  // 2. Strip markdown formatting
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');           // **bold**
  t = t.replace(/\*(.+?)\*/g, '$1');                // *italic*
  t = t.replace(/__(.+?)__/g, '$1');                // __underline__
  t = t.replace(/_(.+?)_/g, '$1');                  // _italic_
  t = t.replace(/#{1,6}\s*/g, '');                  // ## headings
  t = t.replace(/`{1,3}[^`]*`{1,3}/g, '');         // `code`
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');   // [link](url) → link text
  t = t.replace(/https?:\/\/\S+/g, '');            // bare URLs

  // 3. Em-dash / en-dash → natural pause (Kokoro handles '...' well as a short pause)
  t = t.replace(/ — /g, '... ');
  t = t.replace(/—/g, '... ');
  t = t.replace(/–/g, ', ');
  t = t.replace(/…/g, '... ');

  // 4. Typographic quotes → straight ASCII
  t = t.replace(/[‘’]/g, "'");
  t = t.replace(/[“”]/g, '"');

  // 5. Bullet / list symbols → sentence break
  t = t.replace(/·|•|●|▪|►|→/g, '. ');
  t = t.replace(/^\s*\d+\.\s+/gm, '');   // numbered list items
  t = t.replace(/^\s*[-–•]\s+/gm, '');   // dashed / bulleted list items

  // 6. Symbols → spoken words
  t = t.replace(/(\d[\d,]*\.?\d*)\s*%/g, '$1 percent');
  t = t.replace(/\$(\d[\d,]*\.?\d*)/g,   '$1 dollars');
  t = t.replace(/£(\d[\d,]*\.?\d*)/g,    '$1 pounds');
  t = t.replace(/€(\d[\d,]*\.?\d*)/g,    '$1 euros');
  t = t.replace(/&/g,    ' and ');
  t = t.replace(/\+/g,   ' plus ');
  t = t.replace(/#(\w+)/g, '$1');    // #hashtag → hashtag
  t = t.replace(/@(\w+)/g, '$1');    // @mention → mention

  // 7. Common abbreviations → spoken forms
  t = t.replace(/\betc\.\s*/gi,  'et cetera. ');
  t = t.replace(/\be\.g\.\s*/gi, 'for example, ');
  t = t.replace(/\bi\.e\.\s*/gi, 'that is, ');
  t = t.replace(/\bvs\.\s*/gi,   'versus ');
  t = t.replace(/\bDr\.\s+/g,    'Doctor ');
  t = t.replace(/\bMr\.\s+/g,    'Mister ');
  t = t.replace(/\bMrs\.\s+/g,   'Missus ');
  t = t.replace(/\bMs\.\s+/g,    'Miss ');
  t = t.replace(/\bSt\.\s+/g,    'Saint ');
  t = t.replace(/\bApr\.\s*/gi,  'April ');
  t = t.replace(/\bAug\.\s*/gi,  'August ');
  t = t.replace(/\bDec\.\s*/gi,  'December ');
  t = t.replace(/\bFeb\.\s*/gi,  'February ');
  t = t.replace(/\bJan\.\s*/gi,  'January ');
  t = t.replace(/\bJul\.\s*/gi,  'July ');
  t = t.replace(/\bJun\.\s*/gi,  'June ');
  t = t.replace(/\bMar\.\s*/gi,  'March ');
  t = t.replace(/\bNov\.\s*/gi,  'November ');
  t = t.replace(/\bOct\.\s*/gi,  'October ');
  t = t.replace(/\bSep\.\s*/gi,  'September ');

  // 8. Ordinal numbers → spoken words (1st → first … 20th → twentieth)
  const ordinals = {
    '1st':'first','2nd':'second','3rd':'third','4th':'fourth','5th':'fifth',
    '6th':'sixth','7th':'seventh','8th':'eighth','9th':'ninth','10th':'tenth',
    '11th':'eleventh','12th':'twelfth','13th':'thirteenth','14th':'fourteenth',
    '15th':'fifteenth','16th':'sixteenth','17th':'seventeenth','18th':'eighteenth',
    '19th':'nineteenth','20th':'twentieth',
  };
  t = t.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, (m, n, s) => ordinals[(n + s).toLowerCase()] || m);

  // 9. Small integers (1–20) written as digits → words
  const nums = ['zero','one','two','three','four','five','six','seven','eight','nine',
                 'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen',
                 'seventeen','eighteen','nineteen','twenty'];
  t = t.replace(/\b(\d{1,2})\b/g, (m, n) => {
    const i = parseInt(n, 10);
    return (i <= 20 && nums[i]) ? nums[i] : m;
  });

  // 10. Tidy whitespace and stray punctuation artefacts
  t = t.replace(/[ \t]{2,}/g, ' ');           // multiple spaces → one
  t = t.replace(/\n{3,}/g, '\n\n');           // max double newline
  t = t.replace(/([.!?])\s*([.!?])+/g, '$1'); // duplicate end-punctuation
  t = t.replace(/,\s*,/g, ',');               // double commas
  t = t.replace(/\(\s*\)/g, '');              // empty parens
  t = t.replace(/\.\s*\.\s*\./g, '...');      // normalise ellipsis spacing

  return t.trim();
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

// ── WAV stitcher ──────────────────────────────────────────────────────────────
// Stitches multiple WAV buffers into one, inserting silence at boundaries.
// paragraphBreakMs: silence after a paragraph-end chunk (default 350ms)
// sentenceBreakMs: silence between non-paragraph chunks (default 80ms) — prevents
//   abrupt/choppy joins when OmniVoice chunks lack natural trailing silence
function stitchWavBuffers(buffers, paragraphBreakMs = 350, sentenceBreakMs = 80) {
  if (buffers.length === 0) throw new Error('No WAV buffers to stitch');
  if (buffers.length === 1) return buffers[0].buf;

  // Detect sample rate from first buffer's WAV header (bytes 24-27)
  const sampleRate = buffers[0].buf.readUInt32LE(24);
  const channels   = buffers[0].buf.readUInt16LE(22);
  const bitDepth   = buffers[0].buf.readUInt16LE(34);

  const pcmParts = [];
  for (let i = 0; i < buffers.length; i++) {
    const { buf, paragraphEnd } = buffers[i];
    const offset = findDataOffset(buf);
    pcmParts.push(buf.slice(offset));
    if (i < buffers.length - 1) {
      const gapMs = paragraphEnd ? paragraphBreakMs : sentenceBreakMs;
      const silence = silenceWav(gapMs, sampleRate, channels, bitDepth);
      pcmParts.push(silence.slice(44)); // just the PCM data
    }
  }

  const pcm       = Buffer.concat(pcmParts);
  const totalData = pcm.length;

  // Build final WAV from first buffer's header + all PCM
  const firstOffset = findDataOffset(buffers[0].buf);
  const header = Buffer.from(buffers[0].buf.slice(0, firstOffset));
  const out    = Buffer.concat([header, pcm]);
  out.writeUInt32LE(firstOffset - 8 + totalData, 4); // RIFF size = file_size - 8
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

module.exports = { preprocessTTS, chunkTTS, silenceWav, stitchWavBuffers, findDataOffset };
