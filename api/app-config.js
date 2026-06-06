// Shared configuration for the Express server + handlers

const GiB = 1024 * 1024 * 1024;

const LIMITS = {
  // Upload limits (formidable)
  maxVideoFileSizeBytes: Number(process.env.MAX_VIDEO_FILE_SIZE_BYTES) || 2 * GiB,
  maxVideoTotalSizeBytes: Number(process.env.MAX_VIDEO_TOTAL_SIZE_BYTES) || 10 * GiB,
  maxVideoFiles: Number(process.env.MAX_VIDEO_FILES) || 100,

  maxAudioFileSizeBytes: Number(process.env.MAX_AUDIO_FILE_SIZE_BYTES) || 250 * 1024 * 1024,
  maxAudioTotalSizeBytes: Number(process.env.MAX_AUDIO_TOTAL_SIZE_BYTES) || 2 * GiB,
  maxAudioFiles: Number(process.env.MAX_AUDIO_FILES) || 100,

  maxMuxFileSizeBytes: Number(process.env.MAX_MUX_FILE_SIZE_BYTES) || 2 * GiB,

  maxAnnotationFileSizeBytes: Number(process.env.MAX_ANNOTATION_FILE_SIZE_BYTES) || 2 * GiB
};

const VIDEO_PRESETS = {
  draft: {
    preset: 'veryfast',
    crf: 28,
    audioBitrate: '128k'
  },
  balanced: {
    preset: 'medium',
    crf: 22,
    audioBitrate: '160k'
  },
  quality: {
    preset: 'slow',
    crf: 18,
    audioBitrate: '192k'
  }
};

function getVideoPreset(name) {
  const key = String(name || 'balanced').toLowerCase();
  return VIDEO_PRESETS[key] || VIDEO_PRESETS.balanced;
}

module.exports = {
  LIMITS,
  VIDEO_PRESETS,
  getVideoPreset
};
