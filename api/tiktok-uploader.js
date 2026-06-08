// #27 TikTok / Reels Auto-Post
// TikTok: Content Posting API v2 (direct post flow)
// Instagram Reels: Graph API v18 (requires FB Business account)
//
// Required env vars for TikTok:
//   TIKTOK_CLIENT_KEY      — from TikTok Developer Portal
//   TIKTOK_CLIENT_SECRET
//   TIKTOK_ACCESS_TOKEN    — user access token (obtained via OAuth)
//
// Required env vars for Instagram Reels:
//   INSTAGRAM_ACCESS_TOKEN — long-lived user token
//   INSTAGRAM_USER_ID      — numeric IG user ID

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── TikTok Direct Post ────────────────────────────────────────────────────────
async function uploadToTikTok({ videoPath, job, script, logger = () => {} }) {
  const env = process.env;
  const accessToken = env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) throw new Error('TIKTOK_ACCESS_TOKEN not set in .env');

  const title = (job.tiktok_title || script?.title || job.name || 'Video').slice(0, 150);
  const fileSize = fs.statSync(videoPath).size;

  // Step 1: Initialise upload
  logger(`📱 TikTok: initialising upload (${(fileSize / 1048576).toFixed(1)} MB)…`);
  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title,
        privacy_level: job.tiktok_privacy || 'SELF_ONLY', // safe default
        disable_duet:  false,
        disable_stitch: false,
        disable_comment: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source:          'FILE_UPLOAD',
        video_size:      fileSize,
        chunk_size:      fileSize,
        total_chunk_count: 1,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const initData = await initRes.json();
  if (!initRes.ok || initData.error?.code !== 'ok') {
    throw new Error(`TikTok init failed: ${JSON.stringify(initData.error || initData)}`);
  }

  const { publish_id, upload_url } = initData.data;
  logger(`📱 TikTok: upload session ${publish_id}`);

  // Step 2: Upload video chunk
  await new Promise((resolve, reject) => {
    const u      = new URL(upload_url);
    const stream = fs.createReadStream(videoPath);
    const req    = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'PUT',
      headers: {
        'Content-Type':            'video/mp4',
        'Content-Length':          fileSize,
        'Content-Range':           `bytes 0-${fileSize - 1}/${fileSize}`,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`TikTok upload ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    stream.pipe(req);
  });

  logger(`✅ TikTok upload complete! Publish ID: ${publish_id}`);
  return { publish_id, title };
}

// ── Instagram Reels Post ──────────────────────────────────────────────────────
async function uploadToInstagramReels({ videoPath, job, script, logger = () => {} }) {
  const env         = process.env;
  const accessToken = env.INSTAGRAM_ACCESS_TOKEN;
  const userId      = env.INSTAGRAM_USER_ID;
  if (!accessToken || !userId) throw new Error('INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID required in .env');

  // Instagram Reels requires a publicly accessible video URL — not a local file.
  // The video must be served via HTTPS. If job has a public_video_url set, use it.
  const videoUrl = job.public_video_url;
  if (!videoUrl) throw new Error('Instagram Reels upload requires job.public_video_url (a public HTTPS URL to the video)');

  const caption = job.instagram_caption || script?.description || script?.title || job.name || '';

  logger(`📸 Instagram Reels: creating media container…`);
  const createRes = await fetch(
    `https://graph.facebook.com/v18.0/${userId}/media?` +
    new URLSearchParams({
      media_type:    'REELS',
      video_url:     videoUrl,
      caption:       caption.slice(0, 2200),
      access_token:  accessToken,
    }),
    { method: 'POST', signal: AbortSignal.timeout(30_000) }
  );
  const createData = await createRes.json();
  if (createData.error) throw new Error(`IG container: ${createData.error.message}`);
  const containerId = createData.id;
  logger(`📸 Instagram: container ${containerId} — publishing…`);

  // Poll until container is ready (up to 2 min)
  let ready = false;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(
      `https://graph.facebook.com/v18.0/${containerId}?fields=status_code&access_token=${accessToken}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const status = await statusRes.json();
    if (status.status_code === 'FINISHED') { ready = true; break; }
    if (status.status_code === 'ERROR') throw new Error(`IG media processing failed: ${JSON.stringify(status)}`);
  }
  if (!ready) throw new Error('Instagram media processing timed out (2 min)');

  const publishRes = await fetch(
    `https://graph.facebook.com/v18.0/${userId}/media_publish?` +
    new URLSearchParams({ creation_id: containerId, access_token: accessToken }),
    { method: 'POST', signal: AbortSignal.timeout(15_000) }
  );
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`IG publish: ${publishData.error.message}`);

  logger(`✅ Instagram Reels posted! Media ID: ${publishData.id}`);
  return { media_id: publishData.id };
}

// ── Status check helpers ──────────────────────────────────────────────────────
function tiktokConfigured() {
  return !!process.env.TIKTOK_ACCESS_TOKEN;
}
function instagramConfigured() {
  return !!(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID);
}

module.exports = { uploadToTikTok, uploadToInstagramReels, tiktokConfigured, instagramConfigured };
