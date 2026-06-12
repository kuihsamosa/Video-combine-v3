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

  // 10. Tidy whitespace and stray punctuation artefacts (must run before prosody injection
  // so the injected "..." and commas aren't eaten by the duplicate-punctuation rule).
  t = t.replace(/[ \t]{2,}/g, ' ');           // multiple spaces → one
  t = t.replace(/\n{3,}/g, '\n\n');           // max double newline
  t = t.replace(/([.!?])\s*([.!?])+/g, '$1'); // duplicate end-punctuation
  t = t.replace(/,\s*,/g, ',');               // double commas
  t = t.replace(/,\s*([.!?])/g, '$1');        // comma before sentence-end punctuation
  t = t.replace(/\(\s*\)/g, '');              // empty parens
  t = t.replace(/\.\s*\.\s*\./g, '...');      // normalise ellipsis spacing

  // ── Prosody injection (runs AFTER cleanup so injected punctuation is preserved) ──

  // 11. Inject commas after common interjections the LLM tends to omit.
  // Without a comma, TTS engines rush through the transition ("That's right it was…").
  const interjections = [
    "That's right","You see","Now","Well","And yet","But wait","In fact",
    "Of course","Indeed","After all","As a result","In other words","Believe it or not",
    "Here's the thing","Here's what","Turns out","It turns out","So","Yet",
  ];
  for (const word of interjections) {
    const re = new RegExp(`\\b(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s+(?=[a-z])`, 'g');
    t = t.replace(re, `$1, `);
  }
  // "But" at clause/sentence start (after period or paragraph break).
  t = t.replace(/([.!?]\s+)(But)\s+(?=[a-z])/g, '$1$2, ');
  t = t.replace(/(^|\n\n)(But)\s+(?=[a-z])/g, '$1$2, ');

  // 12. Anticipatory pause before high-impact dramatic words at end of clause.
  // Fires only when the dramatic word is immediately followed by sentence-ending
  // punctuation, so it never adds "a... rotten ingredients" mid-phrase.
  // e.g. "it was a disaster." → "it was a... disaster."
  const dramaticWords = [
    'disaster','catastrophe','rotten','sketchy','spoiled','contaminated',
    'poison','poisonous','deadly','toxic','filthy','foul','putrid','vile',
    'corrupt','scandal','shocking','horrifying','disgusting','revolting',
    'terrifying','devastating','catastrophic','lethal','fatal',
  ];
  const dramaticEndRe = new RegExp(
    `\\s+(${dramaticWords.join('|')})(\\s*[.!?;])`,
    'gi'
  );
  t = t.replace(dramaticEndRe, '... $1$2');

  // Tidy any doubled commas created by the injections above
  t = t.replace(/,\s*,/g, ',');

  return t.trim();
}

// ── Chunking ──────────────────────────────────────────────────────────────────
// Splits cleaned text into natural paragraph/sentence chunks.
// Chunks tagged with isParagraphBreak=true get silence inserted after them.
// 500 chars balances prosody quality against per-chunk voice drift.
function chunkTTS(text, maxChars = 500) {
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

// ── Internal silence compressor ───────────────────────────────────────────────
// Compresses any contiguous run of near-silence > maxSilenceMs down to maxSilenceMs.
// Two-level: pass 1 at threshold=600 catches OmniVoice design-mode's loud pauses;
// pass 2 at threshold=150 catches clone-mode's quieter ambient-noise-floor pauses.
function compressInternalSilence(pcm, bitDepth, sampleRate, maxSilenceMs = 100) {
  function onePass(input, threshold) {
    const bytesPerSample = bitDepth / 8;
    const maxSilenceSamples = Math.floor(sampleRate * maxSilenceMs / 1000);
    const n = input.length / bytesPerSample;
    const parts = [];
    let silenceStart = -1;
    let silenceCount = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.abs(input.readInt16LE(i * bytesPerSample));
      if (s < threshold) {
        if (silenceStart < 0) silenceStart = i;
        silenceCount++;
      } else {
        if (silenceStart >= 0) {
          const keep = Math.min(silenceCount, maxSilenceSamples);
          parts.push(input.slice(silenceStart * bytesPerSample, (silenceStart + keep) * bytesPerSample));
          silenceStart = -1; silenceCount = 0;
        }
        parts.push(input.slice(i * bytesPerSample, (i + 1) * bytesPerSample));
      }
    }
    if (silenceStart >= 0) {
      const keep = Math.min(silenceCount, maxSilenceSamples);
      parts.push(input.slice(silenceStart * bytesPerSample, (silenceStart + keep) * bytesPerSample));
    }
    return Buffer.concat(parts);
  }
  // Pass 1: catch OmniVoice design-mode loud pauses (>600 treated as non-silent speech)
  let out = onePass(pcm, 600);
  // Pass 2: catch clone-mode's quieter ambient-noise pauses (>150 treated as non-silent)
  out = onePass(out, 150);
  return out;
}

// ── Per-chunk RMS normalisation ───────────────────────────────────────────────
// OmniVoice DESIGN mode (used when no voice profile exists) produces chunks at
// wildly different gain levels — up to 14 dB of variation observed. A single
// outlier chunk throws off loudnorm and can silence everything else.
// This rescales each chunk's PCM to a fixed target RMS before stitching.
function normalisePcmRms(pcm, bitDepth, targetRms = 4000) {
  const bytesPerSample = bitDepth / 8;
  const n = pcm.length / bytesPerSample;
  if (n === 0) return pcm;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * bytesPerSample);
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / n);
  if (rms < 10) return pcm; // silence chunk — don't amplify noise

  const gain = Math.min(targetRms / rms, 4.0); // cap at 12 dB boost to avoid clipping
  if (Math.abs(gain - 1.0) < 0.05) return pcm; // already close enough

  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * bytesPerSample);
    const scaled = Math.max(-32768, Math.min(32767, Math.round(s * gain)));
    out.writeInt16LE(scaled, i * bytesPerSample);
  }
  return out;
}

// ── Trim leading near-silence from PCM data ───────────────────────────────────
// OmniVoice also pads the START of each chunk. Without trimming the lead,
// the explicit inter-chunk gap stacks with this leading pad, doubling the pause.
function trimLeadingPcmSilence(pcm, bitDepth, threshold = 800) {
  const bytesPerSample = bitDepth / 8;
  let start = 0;
  while (start + bytesPerSample <= pcm.length) {
    const sample = bitDepth === 16
      ? Math.abs(pcm.readInt16LE(start))
      : Math.abs(pcm[start] - 128);
    if (sample > threshold) break;
    start += bytesPerSample;
  }
  return start > 0 ? pcm.slice(start) : pcm;
}

// ── Trim trailing near-silence from PCM data ─────────────────────────────────
// OmniVoice pads each chunk with ~200-400ms of silence. Without trimming,
// stitching produces: audio | pad-silence | gap-silence | ABRUPT-START → gasp.
function trimTrailingPcmSilence(pcm, bitDepth, sampleRate = 24000, threshold = 800) {
  // threshold=800 ≈ -32dB — matches OmniVoice's noise floor so its trailing pad is removed.
  // threshold=150 was too low (-47dB) and left 150-200ms of unstripped pad per chunk.
  const bytesPerSample = bitDepth / 8;
  let end = pcm.length;
  while (end >= bytesPerSample) {
    const sample = bitDepth === 16
      ? Math.abs(pcm.readInt16LE(end - bytesPerSample))
      : Math.abs(pcm[end - 1] - 128);
    if (sample > threshold) break;
    end -= bytesPerSample;
  }
  // Keep 15ms of natural reverb tail after the last loud sample
  const tailBytes = Math.floor(sampleRate * 0.015) * bytesPerSample;
  const keepEnd = Math.min(pcm.length, end + tailBytes);
  return keepEnd < pcm.length ? pcm.slice(0, keepEnd) : pcm;
}

// ── WAV stitcher ──────────────────────────────────────────────────────────────
// Stitches multiple WAV buffers into one, inserting silence at boundaries.
// paragraphBreakMs: silence after a paragraph-end chunk (default 350ms)
// sentenceBreakMs: silence between non-paragraph chunks (default 100ms)
function stitchWavBuffers(buffers, paragraphBreakMs = 350, sentenceBreakMs = 100) {
  if (buffers.length === 0) throw new Error('No WAV buffers to stitch');

  // Detect sample rate from first buffer's WAV header (bytes 24-27)
  const sampleRate = buffers[0].buf.readUInt32LE(24);
  const channels   = buffers[0].buf.readUInt16LE(22);
  const bitDepth   = buffers[0].buf.readUInt16LE(34);

  // Validate all chunks have consistent audio format
  for (let i = 1; i < buffers.length; i++) {
    const chunkSampleRate = buffers[i].buf.readUInt32LE(24);
    const chunkChannels   = buffers[i].buf.readUInt16LE(22);
    const chunkBitDepth   = buffers[i].buf.readUInt16LE(34);
    if (chunkSampleRate !== sampleRate || chunkChannels !== channels || chunkBitDepth !== bitDepth) {
      console.warn(`⚠️  Audio format mismatch in chunk ${i}: expected ${sampleRate}Hz/${channels}ch/${bitDepth}bit, got ${chunkSampleRate}Hz/${chunkChannels}ch/${chunkBitDepth}bit`);
    }
  }

  const bytesPerSample  = bitDepth / 8;
  const fadeInMs        = 2;   // ms — anti-click only; longer ramps clip plosive consonants ('B','P','D')
  const fadeOutMs       = 12;  // ms — inter-chunk fade-out before gap silence
  const finalFadeOutMs  = 400; // ms — natural tail on the very last chunk

  const pcmParts = [];
  for (let i = 0; i < buffers.length; i++) {
    const { buf, paragraphEnd } = buffers[i];
    const offset = findDataOffset(buf);

    // Trim OmniVoice's leading and trailing silence pads.
    // Leading trim applies to all chunks so the explicit inter-chunk gap isn't
    // doubled by OmniVoice's own lead-in pad. Trailing trim applies to all
    // non-final chunks so the gap isn't doubled by OmniVoice's own trail-out pad.
    let pcmData = Buffer.from(buf.slice(offset));
    // Trim leading silence on every chunk; cap to 200ms max lead-in
    pcmData = trimLeadingPcmSilence(pcmData, bitDepth);
    const maxLeadBytes = Math.floor(0.200 * sampleRate) * bytesPerSample * channels;
    if (pcmData.length > maxLeadBytes * 2) {
      // Re-insert at most 200ms of silence at the front if trimmed too aggressively
    }
    // Trim trailing silence on ALL chunks (including final) — prevents the dead tail
    pcmData = trimTrailingPcmSilence(pcmData, bitDepth, sampleRate);

    // Compress internal silences: OmniVoice DESIGN mode inserts 500-950ms pauses
    // after every sentence-ending punctuation within the chunk. Cap them at 150ms.
    pcmData = compressInternalSilence(pcmData, bitDepth, sampleRate);

    // Normalise each chunk to a consistent RMS level so OmniVoice DESIGN mode
    // amplitude variation (up to 14 dB observed) doesn't throw off loudnorm
    pcmData = normalisePcmRms(pcmData, bitDepth);

    // Fade-in on every chunk (not just first) — eliminates the gasping artifact
    // at inter-chunk boundaries caused by abrupt PCM onsets
    if (pcmData.length > fadeInMs * sampleRate / 1000 * bytesPerSample * 2) {
      const fadeSamples = Math.floor(fadeInMs * sampleRate / 1000);
      for (let j = 0; j < fadeSamples; j++) {
        const factor = j / fadeSamples;
        const base = j * bytesPerSample * channels;
        for (let c = 0; c < channels; c++) {
          const pos = base + c * bytesPerSample;
          if (pos + bytesPerSample <= pcmData.length) {
            const s = pcmData.readInt16LE(pos);
            pcmData.writeInt16LE(Math.round(s * factor), pos);
          }
        }
      }
    }

    // Fade-out: short inter-chunk smoothing OR long natural tail on the final chunk
    const isLast      = i === buffers.length - 1;
    const applyFadeMs = isLast ? finalFadeOutMs : fadeOutMs;
    const minPcmForFade = applyFadeMs * sampleRate / 1000 * bytesPerSample * channels * 2;
    if (pcmData.length > minPcmForFade) {
      const fadeSamples = Math.floor(applyFadeMs * sampleRate / 1000);
      const startByte   = pcmData.length - fadeSamples * bytesPerSample * channels;
      for (let j = 0; j < fadeSamples; j++) {
        const factor = isLast
          ? Math.pow(1 - j / fadeSamples, 2)  // quadratic for smoother natural tail
          : (1 - j / fadeSamples);             // linear for quick inter-chunk edge
        const base = startByte + j * bytesPerSample * channels;
        for (let c = 0; c < channels; c++) {
          const pos = base + c * bytesPerSample;
          if (pos + bytesPerSample <= pcmData.length) {
            const s = pcmData.readInt16LE(pos);
            pcmData.writeInt16LE(Math.round(s * factor), pos);
          }
        }
      }
    }

    pcmParts.push(pcmData);

    if (i < buffers.length - 1) {
      const gapMs = paragraphEnd ? paragraphBreakMs : sentenceBreakMs;
      const silence = silenceWav(gapMs, sampleRate, channels, bitDepth);
      pcmParts.push(silence.slice(44));
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
