# Video Combiner - Debugging Guide

## Current Status
✅ **Backend is working correctly** - verified through server logs
✅ **All segments are being extracted** - confirmed in output files
✅ **FFmpeg combining is working** - combined files are created
❓ **Frontend may not be sending all 4 videos** - needs verification

## How to Diagnose

### Step 1: Check What the Frontend is Sending
Open your browser console (F12) and in the Network tab, look at the POST request to `/api/video-combiner`:
1. Click "Process Videos"
2. Go to Network tab
3. Find the request to `/api/video-combiner`
4. Check the Form Data - you should see 4 `videos` entries (all with the name `videos`)

### Step 2: Check Server Logs
After uploading 4 videos, the server log should show:
```
📹 Received 4 video files in array
   [1] videoname1.mp4
   [2] videoname2.mp4
   [3] videoname3.mp4
   [4] videoname4.mp4
```

If you only see 1 video, that's the problem - the frontend isn't sending all 4.

### Step 3: Use Debug Endpoint
Run this command to test the upload with your actual video files:
```bash
curl -F "videos=@path/to/video1.mp4" \
     -F "videos=@path/to/video2.mp4" \
     -F "videos=@path/to/video3.mp4" \
     -F "videos=@path/to/video4.mp4" \
     http://localhost:8080/api/debug-upload
```

This will show you exactly how many videos were received.

## Expected Output When Working

### Server Log Should Show:
```
=== VIDEO COMBINER STARTED ===
📹 Received 4 video files in array
📊 Processing 4 video(s)

📹 [1/4] Processing: video1.mp4
   ⏱️ Duration: 10.00s
   ✂️ Cuts: 5

📹 [2/4] Processing: video2.mp4
   ⏱️ Duration: 5.00s
   ✂️ Cuts: 2

📹 [3/4] Processing: video3.mp4
   ⏱️ Duration: 20.00s
   ✂️ Cuts: 10

📹 [4/4] Processing: video4.mp4
   ⏱️ Duration: 15.00s
   ✂️ Cuts: 7

=== COMBINING SEGMENTS ===
Total segments to combine: 24
From 4 input video(s)
[FFMPEG] Combining 24 segments
   1. seg_0_0.mp4
   2. seg_0_1.mp4
   ...
   24. seg_3_6.mp4
[FFMPEG] ✓ Successfully combined all segments
Output size: ~100MB (depends on video size)
=== Video Combiner Complete ===
```

## Troubleshooting Checklist

- [ ] **Frontend shows "Sending 4 video(s)" in status log?**
  - If NO: Frontend is only uploading 1 video
  
- [ ] **Server log shows "Processing 4 video(s)"?**
  - If NO: Server only received 1 video (frontend problem)
  - If YES: Go to next check

- [ ] **Segments are created with different indices (seg_0, seg_1, seg_2, seg_3)?**
  - If NO: Only seg_0 files exist = only 1 video was processed
  - If YES: All 4 videos were processed correctly

- [ ] **Combined file created successfully?**
  - Check `/Users/macbukbiru/Desktop/Code/Video-combine/output/combined_*.mp4`
  - File should be large (multiple MB)

- [ ] **Downloaded file plays correctly?**
  - Check file with ffprobe to verify all segments are there
  - Duration should be sum of all segment durations

## Commands to Check Everything

```bash
# Check latest output file
ls -lh /Users/macbukbiru/Desktop/Code/Video-combine/output/combined_*.mp4 | tail -1

# Check duration of combined file
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \
  "$(ls -t /Users/macbukbiru/Desktop/Code/Video-combine/output/combined_*.mp4 | head -1)"

# Check server logs
tail -100 /tmp/server.log | grep -E "Processing|Combining|segments"
```

## Next Steps

Once you run the tests:
1. Check which step fails
2. Share the relevant logs
3. We'll fix the specific issue
