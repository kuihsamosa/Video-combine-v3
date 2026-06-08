# Video Combiner — Change Log

All changes relative to the original single-file `video_combiner.py` prototype.  
The project is now a fully Node.js/Express backend with a single-page web UI (`index.html`).

---

## Architecture

| Layer | Before | After |
|---|---|---|
| Runtime | Python (`video_combiner.py`) | Node.js 18+ (`api/server.js`) |
| TTS | Kokoro (port 8880) | OmniVoice (port 8881, MPS / CPU) |
| LLM | None | Groq API (round-robin across 3 keys) |
| UI | None | Single-page app (`index.html`) |
| Storage | None | `scheduler-jobs.json`, `scripts/`, `output/` |

---

## New Files

| File | Purpose |
|---|---|
| `api/server.js` | Express HTTP server — all REST endpoints |
| `api/scheduler.js` | Job lifecycle, concurrency gate, pipeline orchestration |
| `api/planner.js` | AI brainstorm + Reddit trend injection |
| `api/script-generator.js` | Groq LLM script generation |
| `api/script-store.js` | Script archive (save / list / get / delete) |
| `api/footage-finder.js` | Pexels stock footage search + B-roll keyword rewriter |
| `api/caption-generator.js` | ASS subtitle generation (word/line/viral modes) |
| `api/tts-utils.js` | OmniVoice TTS HTTP client |
| `api/ffmpeg.js` | ffmpeg wrapper helpers |
| `api/audio-combiner.js` | Audio mix / loudness normalisation |
| `api/mux-combiner.js` | Video + audio mux pipeline |
| `api/video-combiner.js` | Scene assembly orchestrator |
| `api/youtube-uploader.js` | YouTube Data API v3 OAuth2 upload |
| `api/youtube-auth.js` | OAuth2 consent URL + token exchange helpers |
| `api/tiktok-uploader.js` | TikTok Content Posting API v2 + Instagram Graph API v18 |
| `api/music-finder.js` | Background music search / download |
| `api/annotator.js` | Scene annotation utilities |
| `api/app-config.js` | Shared runtime config |
| `api/http-utils.js` | Fetch retry helpers |
| `api/image-finder.js` | Image search (Pexels / Unsplash) |
| `api/title-card-generator.js` | ffmpeg title card overlay |
| `api/youtube-downloader.js` | yt-dlp wrapper |
| `api/youtube-search.js` | YouTube Data API search |
| `api/youtube-transcript.js` | YouTube transcript fetch |
| `index.html` | Full single-page web UI (6 000+ lines) |
| `start.sh` | Start OmniVoice + Node server, tail logs |
| `stop.sh` | Gracefully stop both services, release ports |
| `changes.md` | This file |

---

## Features Implemented

### Core Pipeline

| # | Feature | Details |
|---|---|---|
| — | Scheduler | Persistent job queue (`scheduler-jobs.json`), cron expressions, manual trigger |
| — | Multi-instance concurrency | `MAX_CONCURRENT=3` gate; overflow queued, drained automatically |
| — | Auto-retry failed jobs | Up to 3 retries with 2-minute back-off; permanent error after exhaustion |
| — | Topic deduplication | 4-hour cooldown per normalised topic (`normalizeTopic`) |

### Script & Content

| # | Feature | Details |
|---|---|---|
| #4 | Hook A/B Test | After script gen, Groq generates alternative hook; urgency scoring picks winner |
| #7 | Script pre-generation | Timer fires 15 min before scheduled run; script cached in `job._cached_script` |
| #22 | Script archive | Every generated script saved to `scripts/` as JSON; UI viewer with delete |
| — | Reddit trend injection | Planner fetches r/\<niche\>/hot.json, injects top post titles into brainstorm prompt |

### Audio & Voice

| # | Feature | Details |
|---|---|---|
| #3 | Loudness normalisation | ffmpeg `loudnorm` filter (target −14 LUFS / −2 TP) on final audio |
| #23 | Voice speed auto-tune | Measures actual audio duration vs 140 WPM target; re-synthesises if off >15 % |
| — | Background music | Optional music track mixed at configurable volume (default 15 %) |

### Video Processing

| # | Feature | Details |
|---|---|---|
| #2 | Intro / Outro clips | Re-encoded to common spec (1080p 30 fps AAC), concat-demuxed |
| #5 | Talking head PiP | Circular-mask overlay, configurable corner (tl/tr/bl/br) and size |
| #9 | Viral captions | ASS word-by-word subtitles, pill background, 4-colour cycle, pop-in animation |
| #11 | Thumbnail generator | ffmpeg frame at 10 % duration → `<job>_thumb.jpg` |
| #12 | B-roll shuffle | Fisher-Yates shuffle on footage candidates per scene per run |
| #13 | Multi-format export | `_shorts.mp4` (608×1080), `_reels.mp4`, `_square.mp4` (1080×1080) |
| #16 | Smart cut pacing | Per-scene word-count ratio adjusts clip duration (0.5×–2.0× base) |
| #19 | B-roll relevance scoring | Keyword overlap filter removes off-topic footage before selection |
| #20 | Auto lower-thirds | ffmpeg drawtext — speaker names (podcast) or key stats (storytelling) |

### Distribution

| # | Feature | Details |
|---|---|---|
| #14 | YouTube auto-upload | OAuth2 resumable upload; stores video ID for stats polling |
| #15 | Webhook notifications | POST payload on job complete / retry / permanent failure |
| #27 | TikTok auto-post | Content Posting API v2 direct-post flow; uses `_shorts.mp4` if available |
| #27 | Instagram Reels auto-post | Graph API v18; polls container until FINISHED; requires public video URL |
| #28 | YouTube stats polling | Polls views / likes / comments 48 h post-upload every 30 min |

### UI — Scheduler Tab

| # | Feature | Details |
|---|---|---|
| — | Job cards | Status badge, thumbnail preview, retry count, YouTube stats (views/likes) |
| — | Job form | Full config form: TTS voice, captions, music, multi-format, social posting, etc. |
| #25 | Job templates | Save any job as a template (📐 button); spawn new jobs from templates |
| #30 | Publish calendar | Monthly grid showing scheduled run times; click a day for job detail |
| — | Batch topics | Import N topics → create N jobs in one click |
| — | Concurrency control | Live MAX_CONCURRENT slider; status bar shows running / pending counts |

### UI — Other Tabs

| # | Feature | Details |
|---|---|---|
| — | Planner tab | AI brainstorm ideas; Reddit trend checkbox; click idea → pre-fill job form |
| — | Outputs tab | Thumbnail grid of rendered videos; delete button per output |
| — | Script archive (📄) | Browse / view / delete all saved scripts |
| — | Templates (📐) | Browse templates, spawn or delete |
| — | Calendar (📅) | Publish schedule calendar |

---

## Environment Variables

```
# LLM (Groq) — at least one required
GROQ_API_KEY=
GROQ_API_KEY_2=          # optional second key (round-robin)
GROQ_API_KEY_3=          # optional third key

# Stock footage
PEXELS_API_KEY=

# YouTube upload (#14 / #28)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=   # obtained via /api/youtube-upload/auth-url flow

# TikTok auto-post (#27)
TIKTOK_ACCESS_TOKEN=

# Instagram Reels auto-post (#27)
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_USER_ID=

# Webhooks (#15) — set per-job in the UI, not global
```

---

## Script Changes

### `start.sh`
- Renamed from Kokoro → **OmniVoice** (port 8881)
- Node server now runs **in the background**, writing to `server.log`; `tail -f` keeps terminal live
- PID files written for both services (`.server.pid`, `.omnivoice.pid`)
- Preflight checks: verifies `node`, `ffmpeg`, warns if `.env` missing
- Creates `scripts/` and `output/` directories on first run
- Single `cleanup` trap stops both services on Ctrl-C / EXIT

### `stop.sh`
- Completely rewritten — was targeting old Kokoro (port 8880), now targets OmniVoice (port 8881)
- Reads PID files for clean shutdown, falls back to port-based kill
- Also kills any orphaned `node api/server.js` process by path

---

## API Endpoints (new / changed)

```
GET  /api/scheduler/jobs                    list all jobs
POST /api/scheduler/jobs                    create job
PUT  /api/scheduler/jobs/:id               update job
GET  /api/scheduler/jobs/:id/run           trigger run now
GET  /api/scheduler/status                 concurrency status
POST /api/scheduler/config                 set MAX_CONCURRENT
POST /api/scheduler/batch-jobs             create N jobs from topic list
DELETE /api/scheduler/output-delete        delete video + thumbnail

GET  /api/scheduler/output/:filename       serve mp4 / jpg outputs

GET  /api/scripts                          list saved scripts
GET  /api/scripts/:id                      get one script
DELETE /api/scripts/:id                    delete script

GET  /api/scheduler/templates              list job templates
POST /api/scheduler/templates              save template from job
DELETE /api/scheduler/templates/:id        delete template
POST /api/scheduler/templates/:id/spawn    create job from template

GET  /api/youtube-upload/auth-url          OAuth2 consent URL
POST /api/youtube-upload/exchange-code     exchange code for refresh token
GET  /api/youtube-upload/status            configured check
POST /api/scheduler/jobs/:id/fetch-stats   manual YouTube stats refresh

GET  /api/social/status                    TikTok / Instagram configured check

POST /api/planner/brainstorm               AI idea generation (+ Reddit trends)
```
