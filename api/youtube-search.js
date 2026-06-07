// YouTube search via yt-dlp — returns results with thumbnail, title, duration, views
// Used exactly like pexels/pixabay: keyword → list of clips to download

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { COOKIE_PATH, cookiesExist } = require('./youtube-auth');

const YT_DLP = (() => {
  for (const c of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp';
})();

// Format seconds → "4:32" or "1:02:14"
function fmtDur(s) {
  if (!s || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

// Pick best available thumbnail URL from a yt-dlp info object
function bestThumb(info) {
  // Prefer maxresdefault
  const thumbs = info.thumbnails || [];
  const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
  const best   = sorted.find(t => t.url?.includes('maxresdefault'))
              || sorted.find(t => t.url?.includes('hqdefault'))
              || sorted[0];
  return best?.url || info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;
}

/**
 * Search YouTube for videos matching `query`.
 * @param {string} query
 * @param {object} opts
 * @param {number}  opts.limit        – max results (default 12)
 * @param {string}  opts.filter       – 'short'|'medium'|'long'|'any' (default 'any')
 * @param {function} opts.logger
 * @returns {Promise<Array>}          – array of result objects
 */
function searchYouTube(query, { limit = 12, filter = 'any', logger } = {}) {
  return new Promise((resolve, reject) => {
    logger?.log?.(`🔍 YouTube search: "${query}" (limit ${limit}, filter: ${filter})`);

    // Build search query with optional duration filter
    // yt-dlp search filter syntax:  ytsearch12,dur<short>:query
    const filterStr = filter !== 'any' ? `,dur<${filter}>` : '';
    const searchStr = `ytsearch${limit}${filterStr}:${query}`;

    const args = [
      '--dump-json',
      '--flat-playlist',
      '--no-download',
      '--no-warnings',
      '--quiet',
    ];

    // Use cookies if available (avoids some rate limits)
    if (cookiesExist()) {
      args.push('--cookies', COOKIE_PATH);
    }

    args.push(searchStr);

    const chunks = [];
    const child  = execFile(YT_DLP, args, {
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });

    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', () => {}); // suppress

    child.on('close', code => {
      const raw  = chunks.join('');
      const lines = raw.split('\n').filter(Boolean);

      const results = [];
      for (const line of lines) {
        try {
          const info = JSON.parse(line);
          if (!info.id) continue;

          const dur = info.duration || 0;

          results.push({
            id:        info.id,
            title:     info.title || 'Untitled',
            url:       `https://www.youtube.com/watch?v=${info.id}`,
            duration:  dur,
            durationFmt: fmtDur(dur),
            thumbnail: bestThumb(info),
            views:     info.view_count || 0,
            uploader:  info.uploader  || info.channel || '',
            source:    'youtube',
          });
        } catch (_) {}
      }

      logger?.log?.(`✅ YouTube: ${results.length} result(s)`);
      resolve(results);
    });

    child.on('error', err => reject(new Error(`yt-dlp error: ${err.message}`)));
  });
}

module.exports = { searchYouTube };
