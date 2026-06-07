# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## What this repo is
A small web app for combining video clips (and optional voiceover + annotations) using FFmpeg.

The app is a single-page frontend (`index.html`) served by an Express server (`api/server.js`). Video/audio processing is performed by spawning `ffmpeg` / `ffprobe` from Node handlers.

## Common commands

### Install
```bash
npm install
```

### Run the server (serves UI + API)
```bash
npm start
# or
npm run dev
# or
./start.sh
```
Server defaults to port `8080` (see `api/server.js`, `PORT = process.env.PORT || 8080`).
Open: `http://localhost:8080`

### Stop the server
```bash
./stop.sh
```

### Optional: Python deps (only needed for transcription-based annotations)
The annotation endpoint can try to transcribe audio via `faster-whisper` (invoked via a Python one-liner in `api/annotator.js`). If it’s not available, it falls back to generating mock annotations.

```bash
python3 -m pip install -r requirements.txt
```

### CLI video combiner (separate from the web app)
There is also a standalone Python CLI:
```bash
python3 video_combiner.py path/to/a.mp4 path/to/b.mp4 -o combined_video
```
Note: the Python CLI reads `config.json`, but the Node server does not; the Node handlers use in-file config + multipart `config` JSON from the browser.

## Manual testing / debugging workflows
There is no automated test runner or linter configured in `package.json`.

### Health check
```bash
curl http://localhost:8080/api/health
```

### Debug upload (verifies how many files the backend received)
From `DEBUGGING.md` / `INVESTIGATION.md`:
```bash
curl -F "videos=@path/to/video1.mp4" \
     -F "videos=@path/to/video2.mp4" \
     -F "videos=@path/to/video3.mp4" \
     -F "videos=@path/to/video4.mp4" \
     http://localhost:8080/api/debug-upload
```

### Video combiner (API-only)
Returns the combined MP4 as the HTTP response body.
```bash
curl -o combined_video.mp4 \
  -F 'config={"min_cut_duration":2,"max_cut_duration":3,"output_format":"mp4"}' \
  -F "videos=@path/to/video1.mp4" \
  -F "videos=@path/to/video2.mp4" \
  http://localhost:8080/api/video-combiner
```

### Temp cleanup (also available from the UI “Delete temp files” button)
```bash
curl -X POST http://localhost:8080/api/cleanup \
  -H 'Content-Type: application/json' \
  -d '{"targets":["temp","temp_mux","temp_audio","output"]}'
```

### Where to look for troubleshooting guidance
- `README.md` (basic setup)
- `TESTING_GUIDE.md` (UI verification checklist)
- `DEBUGGING.md` (debug endpoint + expected logs)
- `INVESTIGATION.md` (context on common “only 1 video uploaded” failures)

## High-level architecture

### Request flow
1. **Frontend**: `index.html`
   - Keeps selected files in memory (`uploadedFiles`, `audioFiles`).
   - Sends multipart requests using `FormData`:
     - `POST /api/video-combiner` with repeated `videos` fields + a `config` JSON field.
     - `POST /api/audio-combiner` with repeated `audios` fields + a `config` JSON field.
     - `POST /api/mux-combiner` with single `video` + `audio` fields.
     - `POST /api/annotate` with `video` and optional `script_pdf`.
     - `POST /api/annotate/render` with `video` + `annotations` JSON.

2. **Server**: `api/server.js`
   - Express server that serves static files from the repo root (so `index.html` is the UI).
   - Uses `formidable` to parse multipart requests and write uploads into temp folders.
   - Provides operational endpoints used by the UI:
     - `GET /api/disk-usage` (reports sizes for temp/output directories)
     - `POST /api/cleanup` (deletes/recreates temp/output directories)
     - `GET /api/temp-analyzer` (lists recent files in temp/output)

3. **Processing handlers** (all spawn `ffmpeg` / `ffprobe`):
   - `api/video-combiner.js`
     - Copies each uploaded file into a per-session directory under `temp/`.
     - Uses `ffprobe` to get duration.
     - Extracts 1 random segment per input video (see `generateRandomCuts`) into `seg_<videoIndex>_<cutIndex>.mp4`.
     - Concatenates segments via the concat demuxer and re-encodes the final output into `output/combined_<session>.mp4`.
     - Streams the output file back in the response.
   - `api/audio-combiner.js`
     - Normalizes clips to PCM WAV, inserts generated silence between clips, then concatenates and outputs `output/voiceover_<session>.<ext>`.
     - Returns the output as the response body.
   - `api/mux-combiner.js`
     - Combines the already-combined video + voiceover into `output/final_<session>.mp4`.
     - If video is longer than audio, it trims video to audio+5s and fades to black; otherwise it pads the shorter stream.
   - `api/annotator.js`
     - Generates annotation timings either from an uploaded PDF script (via `pdf-parse`) or from audio transcription (optional `faster-whisper`), otherwise falls back to mock annotations.
     - `handleAnnotationRender` burns an ASS subtitle track into the video with ffmpeg.

### Log streaming (for UI status)
- The browser generates a `session_id` and includes it in the multipart `config` JSON.
- `api/server.js` uses an in-memory `EventEmitter` per session and exposes:
  - `GET /api/log-stream/:sessionId` (SSE)
  - `GET /api/logs/:sessionId` (polling fallback)
- Handlers receive a `logger` object; server-side log messages are forwarded to the browser status panel.

### File system conventions
- Temporary working dirs: `temp/`, `temp_audio/`, `temp_mux/`
- Outputs written to: `output/`
- If disk space or stale files become an issue, use the UI “Delete temp files” button or `POST /api/cleanup`.
