// Hardware-aware resource manager for video-combine
const os = require('os');

class ResourceManager {
  constructor() {
    this.cpuCount = os.cpus().length;
    this.totalMemGB = os.totalmem() / 1024 ** 3;
    this.freeMemGB = os.freemem() / 1024 ** 3;
    
    // Calculate optimal settings based on hardware
    this.calculateOptimalSettings();
  }
  
  calculateOptimalSettings() {
    // CPU-based limits
    this.maxFfmpegThreads = Math.max(1, Math.floor(this.cpuCount / 4));
    this.maxConcurrentFFmpeg = Math.max(1, Math.floor(this.cpuCount / 3));
    
    // Memory-based limits
    this.maxConcurrentJobs = Math.max(1, Math.min(
      Math.floor(this.totalMemGB / 4),  // 4GB per job
      Math.floor(this.cpuCount / 2),    // 2 CPUs per job
      4                                  // Hard limit
    ));
    
    // Video processing limits
    this.videoSegmentConcurrency = Math.max(1, Math.floor(this.maxConcurrentFFmpeg / 2));
    
    // Cache limits (in MB)
    this.maxCacheSizeMB = Math.max(100, Math.min(1000, Math.floor(this.totalMemGB * 100)));
    
    // Log retention (in minutes)
    this.logRetentionMinutes = Math.max(5, Math.min(60, Math.floor(this.totalMemGB * 5)));
    
    console.log(`[ResourceManager] Hardware detected: ${this.cpuCount} CPUs, ${this.totalMemGB.toFixed(1)}GB RAM`);
    console.log(`[ResourceManager] Optimal settings: maxConcurrentJobs=${this.maxConcurrentJobs}, maxFFmpegThreads=${this.maxFfmpegThreads}, videoSegmentConcurrency=${this.videoSegmentConcurrency}`);
  }
  
  getSettings() {
    return {
      maxConcurrentJobs: this.maxConcurrentJobs,
      maxFfmpegThreads: this.maxFfmpegThreads,
      maxConcurrentFFmpeg: this.maxConcurrentFFmpeg,
      videoSegmentConcurrency: this.videoSegmentConcurrency,
      maxCacheSizeMB: this.maxCacheSizeMB,
      logRetentionMinutes: this.logRetentionMinutes,
      // Override environment variables if set
      ...this.getEnvOverrides()
    };
  }
  
  getEnvOverrides() {
    const env = {};
    if (process.env.MAX_CONCURRENT_JOBS) {
      env.maxConcurrentJobs = Math.min(parseInt(process.env.MAX_CONCURRENT_JOBS), this.maxConcurrentJobs);
    }
    if (process.env.FFMPEG_THREADS) {
      env.maxFfmpegThreads = Math.min(parseInt(process.env.FFMPEG_THREADS), this.maxFfmpegThreads);
    }
    if (process.env.MAX_CACHE_SIZE_MB) {
      env.maxCacheSizeMB = parseInt(process.env.MAX_CACHE_SIZE_MB);
    }
    return env;
  }
  
  getSystemInfo() {
    return {
      cpuCount: this.cpuCount,
      totalMemGB: this.totalMemGB.toFixed(1),
      freeMemGB: this.freeMemGB.toFixed(1),
      memUsagePercent: ((1 - this.freeMemGB / this.totalMemGB) * 100).toFixed(1),
      platform: os.platform(),
      arch: os.arch()
    };
  }
  
  canScheduleJob() {
    // Only allow new jobs if we have enough free memory (>2GB)
    return this.freeMemGB > 2;
  }
  
  getRecommendedConcurrency() {
    const memPressure = 1 - (this.freeMemGB / this.totalMemGB);
    
    if (memPressure > 0.7) {
      // High memory pressure, reduce concurrency
      return Math.max(1, Math.floor(this.maxConcurrentJobs / 2));
    } else if (memPressure > 0.5) {
      // Medium memory pressure
      return Math.max(1, Math.floor(this.maxConcurrentJobs * 0.75));
    } else {
      // Normal operation
      return this.maxConcurrentJobs;
    }
  }
}

// Singleton instance
const resourceManager = new ResourceManager();

module.exports = resourceManager;