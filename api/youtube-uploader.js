// YouTube Auto-Upload (#14)
// Uses YouTube Data API v3 with OAuth2 refresh token flow.
// Required env vars:
//   YOUTUBE_CLIENT_ID      — from Google Cloud Console (OAuth 2.0 client)
//   YOUTUBE_CLIENT_SECRET  — from Google Cloud Console
//   YOUTUBE_REFRESH_TOKEN  — obtained once via consent flow (see /api/youtube/auth)
//
// Optional per-job overrides via job fields:
//   youtube_title      — overrides auto-generated title
//   youtube_description
//   youtube_tags       — comma-separated string
//   youtube_privacy    — 'public' | 'unlisted' | 'private' (default: 'private')

const fs   = require('fs');
const path = require('path');
const https = require('https');

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL_BASE = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

// ── Refresh the access token using stored refresh token ──────────────────────
async function getAccessToken(env) {
  const { YOUTUBE_CLIENT_ID: clientId, YOUTUBE_CLIENT_SECRET: clientSecret, YOUTUBE_REFRESH_TOKEN: refreshToken } = env;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube OAuth not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN in .env');
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();

  const r = await fetch(OAUTH_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Initiate resumable upload, return upload session URI ──────────────────────
async function initiateUpload(accessToken, metadata) {
  const body = JSON.stringify(metadata);
  const r = await fetch(UPLOAD_URL_BASE, {
    method: 'POST',
    headers: {
      'Authorization':    `Bearer ${accessToken}`,
      'Content-Type':     'application/json',
      'X-Upload-Content-Type': 'video/mp4',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`YouTube initiate upload ${r.status}: ${txt.slice(0, 200)}`);
  }
  const location = r.headers.get('location');
  if (!location) throw new Error('YouTube did not return upload session URI');
  return location;
}

// ── Stream file to the resumable upload URI ───────────────────────────────────
function uploadFileStream(sessionUri, filePath, logger) {
  return new Promise((resolve, reject) => {
    const stat     = fs.statSync(filePath);
    const fileSize = stat.size;
    const readStream = fs.createReadStream(filePath);
    const url = new URL(sessionUri);

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'PUT',
      headers: {
        'Content-Length': fileSize,
        'Content-Type':   'video/mp4',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve({ id: 'unknown' });
          }
        } else {
          reject(new Error(`YouTube upload ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);

    // Progress logging every 10%
    let uploaded = 0;
    let lastPct  = 0;
    readStream.on('data', (chunk) => {
      uploaded += chunk.length;
      const pct = Math.floor((uploaded / fileSize) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        logger?.(`   ⬆️  Upload progress: ${pct}% (${(uploaded/1048576).toFixed(1)} MB / ${(fileSize/1048576).toFixed(1)} MB)`);
      }
    });

    readStream.pipe(req);
  });
}

// ── Main upload function ──────────────────────────────────────────────────────
async function uploadToYouTube({ videoPath, job, script, logger = () => {} }) {
  const env = process.env;

  logger(`📺 YouTube Upload: authenticating…`);
  const accessToken = await getAccessToken(env);

  const title       = job.youtube_title       || script?.title || job.name || 'Untitled Video';
  const description = job.youtube_description || script?.description || `${job.niche || ''}\n\nCreated with Video-Combine`;
  const rawTags     = job.youtube_tags         || `${job.niche || ''},${job.platform || 'YouTube'}`;
  const tags        = rawTags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 30);
  const privacy     = job.youtube_privacy      || 'private'; // safe default

  const metadata = {
    snippet: {
      title:       title.slice(0, 100),
      description: description.slice(0, 5000),
      tags,
      categoryId:  '22', // People & Blogs (safe default)
    },
    status: {
      privacyStatus:           privacy,
      selfDeclaredMadeForKids: false,
    },
  };

  logger(`📺 Initiating upload: "${title}" (${privacy})…`);
  const sessionUri = await initiateUpload(accessToken, metadata);

  logger(`📺 Uploading video (${(fs.statSync(videoPath).size / 1048576).toFixed(1)} MB)…`);
  const result = await uploadFileStream(sessionUri, videoPath, logger);

  const videoId = result.id || 'unknown';
  const url     = `https://www.youtube.com/watch?v=${videoId}`;
  logger(`✅ YouTube upload complete! Video ID: ${videoId}`);
  logger(`   🔗 ${url}`);

  return { videoId, url, title, privacy };
}

// ── OAuth consent flow helper (one-time setup) ────────────────────────────────
// Returns a URL the user visits to grant access. After granting, they get a
// code which must be exchanged for refresh_token via /api/youtube/exchange-code
function getConsentUrl(env) {
  const { YOUTUBE_CLIENT_ID: clientId } = env;
  if (!clientId) throw new Error('YOUTUBE_CLIENT_ID not set');
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  'urn:ietf:wg:oauth:2.0:oob',
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type:   'offline',
    prompt:        'consent',
  });
  return `https://accounts.google.com/o/oauth2/auth?${params}`;
}

async function exchangeCodeForTokens(code, env) {
  const { YOUTUBE_CLIENT_ID: clientId, YOUTUBE_CLIENT_SECRET: clientSecret } = env;
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    client_id:    clientId,
    client_secret: clientSecret,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
    code,
  }).toString();

  const r = await fetch(OAUTH_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await r.json();
  if (!data.refresh_token) throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

module.exports = { uploadToYouTube, getConsentUrl, exchangeCodeForTokens };
