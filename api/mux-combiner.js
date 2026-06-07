// Mux Combiner - combines a pre-combined video with a pre-combined voiceover

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');

const execAsync = promisify(exec);

const MUX_CONFIG = {
  tempDir: path.join(__dirname, '../temp_mux'),
  outputDir: path.join(__dirname, '../output')
};

function ensureMuxDirectories() {
  [MUX_CONFIG.tempDir, MUX_CONFIG.outputDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

async function getDurationSeconds(inputPath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
  );
  return parseFloat(stdout.trim()) || 0;
}

  async function handleMuxCombiner(req, res, { files, fields }, logger = console) {
  const log = (...args) => {
    if (logger && typeof logger.log === 'function') {
      logger.log(...args);
    } else {
      console.log(...args);
    }
  };
  const error = (...args) => {
    if (logger && typeof logger.error === 'function') {
      logger.error(...args);
    } else {
      console.error(...args);
    }
  };

  try {
    ensureMuxDirectories();

    // Parse configuration
    let config = {
      trim_video_to_audio_length: true, // Default: trim video to match audio length when video exceeds audio
      add_video_tail_with_fade: false, // Alternative: add tail with fade effect when video exceeds audio
      tail_duration: 5, // Duration of video tail (when adding tail)
      fade_duration: 1 // Duration of fade effect (when adding tail)
    };

    if (fields && fields.config) {
      const configStr = Array.isArray(fields.config) ? fields.config[0] : fields.config;
      try {
        config = { ...config, ...JSON.parse(configStr) };
      } catch (e) {
        error('Config parse error:', e.message);
        // Continue with defaults
      }
    }

    log('\n=== MUX COMBINER (VIDEO + VOICEOVER) STARTED ===');
    log('Files object:', JSON.stringify(Object.keys(files)));
    log(`Config: trim_video_to_audio_length=${config.trim_video_to_audio_length}, add_video_tail_with_fade=${config.add_video_tail_with_fade}, tail_duration=${config.tail_duration}`);

    const video = files.video;
    const audio = files.audio;

    if (!video || !audio) {
      return res.status(400).json({ error: 'Both video and audio files are required' });
    }

    const sessionId = crypto.randomBytes(4).toString('hex');
    const sessionDir = path.join(MUX_CONFIG.tempDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    try {
      const videoName = video.originalFilename || video.filename;
      const audioName = audio.originalFilename || audio.filename;

      const videoExt = path.extname(videoName) || '.mp4';
      const audioExt = path.extname(audioName) || '.mp3';

      const videoInputPath = path.join(sessionDir, `video_input${videoExt}`);
      const audioInputPath = path.join(sessionDir, `audio_input${audioExt}`);

      fs.copyFileSync(video.filepath, videoInputPath);
      fs.copyFileSync(audio.filepath, audioInputPath);

      log(`Video input: ${videoName} -> ${videoInputPath}`);
      log(`Audio input: ${audioName} -> ${audioInputPath}`);

      const outputPath = path.join(MUX_CONFIG.outputDir, `final_${sessionId}.mp4`);
      log(`Final output path: ${outputPath}`);

      // Compute durations so we can trim video to voiceover length when video is longer.
      let videoDuration = 0;
      let audioDuration = 0;
      try {
        videoDuration = await getDurationSeconds(videoInputPath);
        audioDuration = await getDurationSeconds(audioInputPath);
        log(`Durations -> video: ${videoDuration.toFixed(2)}s, audio: ${audioDuration.toFixed(2)}s`);
      } catch (durErr) {
        log(`Duration probe failed, proceeding without trim: ${durErr.message}`);
      }

      let cmd;

      if (videoDuration > 0 && audioDuration > 0) {
        if (videoDuration > audioDuration) {
          // Video exceeds audio - handle based on user preference
          if (config.add_video_tail_with_fade) {
            // Add tail with fade effect: trim video to audio + tail, always fade last 2s to black
            const tailSeconds = config.tail_duration || 5;
            const targetVideo = audioDuration + tailSeconds;
            const fadeStart = Math.max(0, targetVideo - 2);
            const videoFilter = `[0:v]trim=duration=${targetVideo.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,fade=t=out:st=${fadeStart.toFixed(3)}:d=2:color=black[vout]`;
            const audioFilter = `[1:a]atrim=duration=${audioDuration.toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${tailSeconds},afade=t=out:st=${fadeStart.toFixed(3)}:d=2[aout]`;
            const filterComplex = `${videoFilter};${audioFilter}`;
            cmd = `ffmpeg -y -i "${videoInputPath}" -i "${audioInputPath}" -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac -b:a 160k -movflags +faststart "${outputPath}"`;
            log(`[FFMPEG-MUX] Video exceeds audio - adding ${tailSeconds}s tail with 2s fade to black`);
          } else {
            // Trim video to audio length, always fade last 2s to black
            const fadeStart = Math.max(0, audioDuration - 2);
            const videoFilter = `[0:v]trim=duration=${audioDuration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,fade=t=out:st=${fadeStart.toFixed(3)}:d=2:color=black[vout]`;
            const audioFilter = `[1:a]asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart.toFixed(3)}:d=2[aout]`;
            const filterComplex = `${videoFilter};${audioFilter}`;
            cmd = `ffmpeg -y -i "${videoInputPath}" -i "${audioInputPath}" -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac -b:a 160k -movflags +faststart "${outputPath}"`;
            log(`[FFMPEG-MUX] Video exceeds audio - trimming to ${audioDuration.toFixed(2)}s with 2s fade to black`);
          }
        } else {
          // Audio exceeds video - pad video to match audio length, fade last 2s to black
          const videoPadSeconds = audioDuration - videoDuration;
          const videoPadFilter = videoPadSeconds > 0
            ? `,tpad=stop_mode=clone:stop_duration=${videoPadSeconds.toFixed(3)}`
            : '';
          const fadeStart = Math.max(0, audioDuration - 2);
          const audioFilter = `[1:a]asetpts=PTS-STARTPTS,afade=t=out:st=${fadeStart.toFixed(3)}:d=2[aout]`;
          const filterComplex = `[0:v]format=yuv420p${videoPadFilter},fade=t=out:st=${fadeStart.toFixed(3)}:d=2:color=black[vout];${audioFilter}`;
          cmd = `ffmpeg -y -i "${videoInputPath}" -i "${audioInputPath}" -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac -b:a 160k -movflags +faststart "${outputPath}"`;
          log(`[FFMPEG-MUX] Audio exceeds video - padding by ${videoPadSeconds.toFixed(2)}s with 2s fade to black`);
        }
      } else {
        // Fallback: basic combine without duration checks (no fade since duration unknown)
        const filterComplex = `[0:v]format=yuv420p[vout];[1:a]anull[aout]`;
        cmd = `ffmpeg -y -i "${videoInputPath}" -i "${audioInputPath}" -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac -b:a 160k -movflags +faststart "${outputPath}"`;
        log(`[FFMPEG-MUX] Basic combine (duration probe failed)`);
      }

      // Re-encode video when padding/trim to allow black tail and faststart for web playback.
      log(`[FFMPEG-MUX] Running: ${cmd}`);

      const { stdout, stderr } = await execAsync(cmd);
      log(`[FFMPEG-MUX] finished. stderr length: ${stderr.length}, stdout length: ${stdout.length}`);

      if (!fs.existsSync(outputPath)) {
        throw new Error('Final muxed file not created');
      }
      const stats = fs.statSync(outputPath);
      if (stats.size === 0) {
        throw new Error('Final muxed file is empty');
      }

      const outputBuffer = fs.readFileSync(outputPath);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="final_content.mp4"');
      res.setHeader('Content-Length', outputBuffer.length);
      res.send(outputBuffer);

      log('=== Mux Combiner Complete ===');

      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (processingError) {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
      throw processingError;
    }
  } catch (e) {
    error('Mux processing error:', e);
    res.status(500).json({
      error: 'Mux processing failed',
      details: e.message
    });
  }
}

module.exports = { handleMuxCombiner, MUX_CONFIG };
