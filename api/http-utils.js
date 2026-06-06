const path = require('path');

function getVideoContentTypeByExt(filenameOrExt) {
  const ext = String(filenameOrExt || '').startsWith('.')
    ? String(filenameOrExt).toLowerCase()
    : path.extname(String(filenameOrExt || '')).toLowerCase();

  switch (ext) {
    case '.avi':
      return 'video/x-msvideo';
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    case '.mp4':
    default:
      return 'video/mp4';
  }
}

function safeRm(targetPath) {
  try {
    const fs = require('fs');
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  } catch (_) {}
}

module.exports = {
  getVideoContentTypeByExt,
  safeRm
};
