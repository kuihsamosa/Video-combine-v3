#!/usr/bin/env python3
"""
Video Combiner Tool - Combines batches of videos using ffmpeg with randomized cuts
"""

import os
import random
import subprocess
import json
import logging
from pathlib import Path
from typing import List, Tuple, Optional
import argparse

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class VideoCombiner:
    def __init__(self, config_path: str = "config.json"):
        """Initialize the video combiner with configuration."""
        self.config = self.load_config(config_path)
        self.temp_dir = Path(self.config.get("temp_dir", "temp"))
        self.temp_dir.mkdir(exist_ok=True)
        
    def load_config(self, config_path: str) -> dict:
        """Load configuration from file or create default."""
        default_config = {
            "output_dir": "output",
            "temp_dir": "temp",
            "min_cut_duration": 2.0,
            "max_cut_duration": 10.0,
            "output_format": "mp4",
            "video_codec": "libx264",
            "audio_codec": "aac",
            "ffmpeg_preset": "medium",
            "random_seed": None
        }
        
        if os.path.exists(config_path):
            try:
                with open(config_path, 'r') as f:
                    user_config = json.load(f)
                default_config.update(user_config)
            except Exception as e:
                logger.warning(f"Could not load config file: {e}. Using defaults.")
        else:
            # Create default config file
            with open(config_path, 'w') as f:
                json.dump(default_config, f, indent=2)
            logger.info(f"Created default config file: {config_path}")
            
        return default_config
    
    def get_video_duration(self, video_path: str) -> float:
        """Get the duration of a video file using ffmpeg."""
        cmd = [
            'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', video_path
        ]
        
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return float(result.stdout.strip())
        except subprocess.CalledProcessError as e:
            logger.error(f"Error getting duration for {video_path}: {e}")
            return 0.0
    
    def generate_random_cuts(self, video_path: str, duration: float) -> List[Tuple[float, float]]:
        """Generate random cut segments for a video."""
        if duration <= 0:
            return []
        
        min_duration = self.config["min_cut_duration"]
        max_duration = self.config["max_cut_duration"]
        
        cuts = []
        current_time = 0.0
        
        # Set random seed if specified
        if self.config["random_seed"] is not None:
            random.seed(self.config["random_seed"])
        
        while current_time < duration:
            # Calculate remaining time
            remaining_time = duration - current_time
            
            # Determine cut duration
            cut_duration = random.uniform(min_duration, min(max_duration, remaining_time))
            
            # Add cut segment
            cuts.append((current_time, min(current_time + cut_duration, duration)))
            
            # Move to next position
            current_time += cut_duration
            
            # Add small random gap between cuts (optional)
            if current_time < duration:
                gap = random.uniform(0.1, 0.5)
                current_time += gap
        
        return cuts
    
    def extract_video_segment(self, video_path: str, start_time: float, end_time: str, output_path: str) -> bool:
        """Extract a segment from a video using ffmpeg."""
        duration = end_time - start_time
        cmd = [
            'ffmpeg', '-y', '-i', video_path,
            '-ss', str(start_time),
            '-t', str(duration),
            '-c:v', self.config["video_codec"],
            '-c:a', self.config["audio_codec"],
            '-preset', self.config["ffmpeg_preset"],
            '-avoid_negative_ts', '1',
            output_path
        ]
        
        try:
            subprocess.run(cmd, capture_output=True, text=True, check=True)
            logger.info(f"Extracted segment: {output_path}")
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"Error extracting segment from {video_path}: {e}")
            return False
    
    def create_video_list(self, segment_paths: List[str], list_path: str) -> None:
        """Create a file list for ffmpeg concatenation."""
        with open(list_path, 'w') as f:
            for path in segment_paths:
                # Escape single quotes in file paths
                escaped_path = path.replace("'", "'\"'\"'")
                f.write(f"file '{escaped_path}'\n")
    
    def combine_videos(self, list_path: str, output_path: str) -> bool:
        """Combine videos using ffmpeg concatenation."""
        cmd = [
            'ffmpeg', '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', list_path,
            '-c', 'copy',
            output_path
        ]
        
        try:
            subprocess.run(cmd, capture_output=True, text=True, check=True)
            logger.info(f"Combined videos into: {output_path}")
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"Error combining videos: {e}")
            return False
    
    def process_video_batch(self, video_paths: List[str], output_name: str) -> Optional[str]:
        """Process a batch of videos with random cuts and combine them."""
        if not video_paths:
            logger.error("No video paths provided")
            return None
        
        # Create output directory
        output_dir = Path(self.config["output_dir"])
        output_dir.mkdir(exist_ok=True)
        
        segment_paths = []
        
        # Process each video
        for video_path in video_paths:
            if not os.path.exists(video_path):
                logger.warning(f"Video file not found: {video_path}")
                continue
            
            logger.info(f"Processing video: {video_path}")
            
            # Get video duration
            duration = self.get_video_duration(video_path)
            if duration <= 0:
                logger.warning(f"Could not get duration for: {video_path}")
                continue
            
            # Generate random cuts
            cuts = self.generate_random_cuts(video_path, duration)
            logger.info(f"Generated {len(cuts)} cuts for {video_path}")
            
            # Extract segments
            video_name = Path(video_path).stem
            for i, (start, end) in enumerate(cuts):
                segment_name = f"{video_name}_segment_{i:03d}.{self.config['output_format']}"
                segment_path = self.temp_dir / segment_name
                
                if self.extract_video_segment(video_path, start, end, str(segment_path)):
                    segment_paths.append(str(segment_path))
        
        if not segment_paths:
            logger.error("No segments were successfully extracted")
            return None
        
        # Create file list for concatenation
        list_path = self.temp_dir / "filelist.txt"
        self.create_video_list(segment_paths, str(list_path))
        
        # Combine videos
        output_path = output_dir / f"{output_name}.{self.config['output_format']}"
        if self.combine_videos(str(list_path), str(output_path)):
            logger.info(f"Successfully created combined video: {output_path}")
            return str(output_path)
        else:
            return None
    
    def cleanup_temp_files(self):
        """Clean up temporary files."""
        try:
            import shutil
            shutil.rmtree(self.temp_dir)
            logger.info("Cleaned up temporary files")
        except Exception as e:
            logger.warning(f"Could not clean up temp files: {e}")

def main():
    parser = argparse.ArgumentParser(description="Video Combiner Tool")
    parser.add_argument("videos", nargs="+", help="Video files to process")
    parser.add_argument("-o", "--output", default="combined_video", help="Output filename")
    parser.add_argument("-c", "--config", default="config.json", help="Configuration file path")
    parser.add_argument("--cleanup", action="store_true", help="Clean up temp files after processing")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without processing")
    
    args = parser.parse_args()
    
    # Initialize combiner
    combiner = VideoCombiner(args.config)
    
    # Validate video files
    valid_videos = []
    for video in args.videos:
        if os.path.exists(video):
            valid_videos.append(video)
        else:
            logger.warning(f"Video file not found: {video}")
    
    if not valid_videos:
        logger.error("No valid video files found")
        return
    
    if args.dry_run:
        logger.info(f"Would process {len(valid_videos)} videos:")
        for video in valid_videos:
            duration = combiner.get_video_duration(video)
            cuts = combiner.generate_random_cuts(video, duration)
            logger.info(f"  {video}: {duration:.2f}s, {len(cuts)} cuts")
        return
    
    # Process videos
    result = combiner.process_video_batch(valid_videos, args.output)
    
    if result:
        logger.info(f"Success! Combined video saved to: {result}")
        
        if args.cleanup:
            combiner.cleanup_temp_files()
    else:
        logger.error("Failed to combine videos")
        if not args.cleanup:
            logger.info("Temporary files preserved for debugging")

if __name__ == "__main__":
    main()
