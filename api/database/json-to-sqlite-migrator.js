const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DatabaseClient = require('../database/client');
const MigrationManager = require('../database/migrations');
const Job = require('../models/Job');
const JobRun = require('../models/JobRun');
const Script = require('../models/Script');

class JsonToSqliteMigrator {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(__dirname, '../../database/app.db');
    this.jobsFilePath = options.jobsFilePath || path.join(__dirname, '../../scheduler-jobs.json');
    this.scriptsDir = options.scriptsDir || path.join(__dirname, '../../scripts');
    this.backupDir = options.backupDir || path.join(__dirname, '../../backups');
    this.dryRun = options.dryRun || false;
    this.db = null;
    this.jobModel = null;
    this.jobRunModel = null;
    this.scriptModel = null;
  }

  async migrate() {
    console.log('Starting JSON to SQLite migration...');

    if (this.dryRun) {
      console.log('DRY RUN MODE - No changes will be made');
    }

    try {
      this.db = new DatabaseClient(this.dbPath);
      this.db.connect();

      const migrationManager = new MigrationManager(this.db.getConnection());
      migrationManager.migrate();

      this.jobModel = new Job(this.db);
      this.jobRunModel = new JobRun(this.db);
      this.scriptModel = new Script(this.db);

      const stats = {
        jobsMigrated: 0,
        jobRunsMigrated: 0,
        scriptsMigrated: 0,
        errors: []
      };

      await this._createBackup();

      await this._migrateJobs(stats);
      await this._migrateScripts(stats);

      console.log('Migration completed:', stats);

      return stats;
    } catch (error) {
      console.error('Migration failed:', error);
      throw error;
    } finally {
      if (this.db) {
        this.db.close();
      }
    }
  }

  async _createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(this.backupDir, `backup_${timestamp}`);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    console.log('Creating backups...');

    if (fs.existsSync(this.jobsFilePath)) {
      const jobsBackup = path.join(backupDir, 'scheduler-jobs.json');
      fs.copyFileSync(this.jobsFilePath, jobsBackup);
      console.log(`Backed up: ${this.jobsFilePath} -> ${jobsBackup}`);
    }

    if (fs.existsSync(this.scriptsDir)) {
      const scriptsBackup = path.join(backupDir, 'scripts');
      this._copyDirectory(this.scriptsDir, scriptsBackup);
      console.log(`Backed up: ${this.scriptsDir} -> ${scriptsBackup}`);
    }

    if (!this.dryRun && fs.existsSync(this.dbPath)) {
      const dbBackup = path.join(backupDir, 'app.db');
      fs.copyFileSync(this.dbPath, dbBackup);
      console.log(`Backed up: ${this.dbPath} -> ${dbBackup}`);
    }

    console.log(`Backups created in: ${backupDir}`);
    return backupDir;
  }

  _copyDirectory(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this._copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  async _migrateJobs(stats) {
    if (!fs.existsSync(this.jobsFilePath)) {
      console.log('No jobs file found, skipping job migration');
      return;
    }

    const jobsData = fs.readFileSync(this.jobsFilePath, 'utf8');
    const jobs = JSON.parse(jobsData);

    console.log(`Found ${jobs.length} jobs to migrate`);

    for (const job of jobs) {
      try {
        this._migrateJob(job);
        stats.jobsMigrated++;
      } catch (error) {
        console.error(`Failed to migrate job ${job.id}:`, error);
        stats.errors.push({ type: 'job', id: job.id, error: error.message });
      }
    }
  }

  _migrateJob(job) {
    const jobData = {
      id: job.id,
      name: job.name,
      topic: job.topic,
      config: this._extractConfig(job),
      status: this._normalizeStatus(job.status),
      enabled: job.enabled !== undefined ? job.enabled : 1,
      schedule: job.schedule,
      next_run_at: job.next_run_ms ? new Date(job.next_run_ms).toISOString() : null,
      last_run_id: job.last_run_id || job.current_run_id
    };

    if (!this.dryRun) {
      this.jobModel.create(jobData);

      if (job.run_history && job.run_history.length > 0) {
        for (const run of job.run_history) {
          this._migrateJobRun(job.id, run);
        }
      }
    }
  }

  _extractConfig(job) {
    const config = {
      niche: job.niche,
      platform: job.platform,
      goal: job.goal,
      tone: job.tone,
      style: job.style,
      duration_minutes: job.duration_minutes,
      orientation: job.orientation,
      voice: job.voice,
      speed: job.speed,
      model: job.model,
      clips_per_scene: job.clips_per_scene,
      use_youtube: job.use_youtube,
      use_pexels: job.use_pexels,
      use_pixabay: job.use_pixabay,
      auto_captions: job.auto_captions,
      caption_template: job.caption_template,
      color_grade: job.color_grade,
      title_cards: job.title_cards,
      cut_duration_seconds: job.cut_duration_seconds,
      tts_provider: job.tts_provider,
      auto_loop: job.auto_loop,
      background_music: job.background_music,
      music_volume: job.music_volume,
      multi_format_export: job.multi_format_export,
      webhook_url: job.webhook_url,
      intro_clip: job.intro_clip,
      outro_clip: job.outro_clip,
      hook_ab_test: job.hook_ab_test,
      talking_head_path: job.talking_head_path,
      pip_size: job.pip_size,
      pip_corner: job.pip_corner,
      youtube_auto_upload: job.youtube_auto_upload,
      youtube_privacy: job.youtube_privacy,
      youtube_title: job.youtube_title,
      youtube_description: job.youtube_description,
      youtube_tags: job.youtube_tags,
      auto_lower_thirds: job.auto_lower_thirds,
      tiktok_auto_post: job.tiktok_auto_post,
      tiktok_privacy: job.tiktok_privacy,
      tiktok_title: job.tiktok_title,
      instagram_auto_post: job.instagram_auto_post,
      instagram_caption: job.instagram_caption,
      public_video_url: job.public_video_url,
      steps: job.steps,
      _from_planner: job._from_planner,
      _planner_idea_id: job._planner_idea_id
    };

    return config;
  }

  _normalizeStatus(status) {
    if (!status) return 'queued';
    
    const statusMap = {
      'running': 'running',
      'idle': 'queued',
      'queued': 'queued',
      'completed': 'completed',
      'failed': 'failed',
      'cancelled': 'cancelled'
    };

    return statusMap[status] || 'queued';
  }

  _migrateJobRun(jobId, run) {
    const runData = {
      id: run.id || crypto.randomBytes(8).toString('hex'),
      job_id: jobId,
      status: run.status || 'completed',
      started_at: run.started_at || run.timestamp,
      completed_at: run.completed_at,
      logs: run.logs || [],
      output_files: run.output_files || [],
      error_message: run.error_message
    };

    if (!this.dryRun) {
      this.jobRunModel.create(runData);
    }
  }

  async _migrateScripts(stats) {
    if (!fs.existsSync(this.scriptsDir)) {
      console.log('No scripts directory found, skipping script migration');
      return;
    }

    const scriptFiles = fs.readdirSync(this.scriptsDir)
      .filter(f => f.endsWith('.json'));

    console.log(`Found ${scriptFiles.length} scripts to migrate`);

    for (const filename of scriptFiles) {
      try {
        const filePath = path.join(this.scriptsDir, filename);
        const scriptData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        this._migrateScript(scriptData);
        stats.scriptsMigrated++;
      } catch (error) {
        console.error(`Failed to migrate script ${filename}:`, error);
        stats.errors.push({ type: 'script', id: filename, error: error.message });
      }
    }
  }

  _migrateScript(scriptData) {
    const scriptRecord = {
      id: scriptData.id || path.basename(scriptData.path || '', '.json'),
      topic: scriptData.topic || scriptData.title,
      content: scriptData.script || scriptData.content,
      job_id: scriptData.job_id
    };

    if (!this.dryRun) {
      this.scriptModel.create(scriptRecord);
    }
  }

  async rollback() {
    console.log('Rolling back migration...');

    const backups = this._getLatestBackup();

    if (!backups) {
      throw new Error('No backup found for rollback');
    }

    if (this.dryRun) {
      console.log('DRY RUN MODE - Would restore from:', backups);
      return;
    }

    if (fs.existsSync(backups.jobs)) {
      fs.copyFileSync(backups.jobs, this.jobsFilePath);
      console.log(`Restored: ${backups.jobs} -> ${this.jobsFilePath}`);
    }

    if (fs.existsSync(backups.scripts)) {
      if (fs.existsSync(this.scriptsDir)) {
        fs.rmSync(this.scriptsDir, { recursive: true, force: true });
      }
      this._copyDirectory(backups.scripts, this.scriptsDir);
      console.log(`Restored: ${backups.scripts} -> ${this.scriptsDir}`);
    }

    if (fs.existsSync(this.dbPath)) {
      fs.unlinkSync(this.dbPath);
      console.log(`Deleted database: ${this.dbPath}`);
    }

    console.log('Rollback completed');
  }

  _getLatestBackup() {
    if (!fs.existsSync(this.backupDir)) {
      return null;
    }

    const backups = fs.readdirSync(this.backupDir)
      .filter(name => name.startsWith('backup_'))
      .sort()
      .reverse();

    if (backups.length === 0) {
      return null;
    }

    const latestBackup = path.join(this.backupDir, backups[0]);

    return {
      jobs: path.join(latestBackup, 'scheduler-jobs.json'),
      scripts: path.join(latestBackup, 'scripts'),
      path: latestBackup
    };
  }

  verify() {
    console.log('Verifying migration...');

    const jobCount = this.jobModel.count();
    const scriptCount = this.scriptModel.count();

    let expectedJobs = 0;
    if (fs.existsSync(this.jobsFilePath)) {
      const jobs = JSON.parse(fs.readFileSync(this.jobsFilePath, 'utf8'));
      expectedJobs = jobs.length;
    }

    let expectedScripts = 0;
    if (fs.existsSync(this.scriptsDir)) {
      const scriptFiles = fs.readdirSync(this.scriptsDir)
        .filter(f => f.endsWith('.json'));
      expectedScripts = scriptFiles.length;
    }

    const verification = {
      jobs: { migrated: jobCount, expected: expectedJobs, match: jobCount === expectedJobs },
      scripts: { migrated: scriptCount, expected: expectedScripts, match: scriptCount === expectedScripts }
    };

    console.log('Verification results:', verification);

    return verification;
  }
}

module.exports = JsonToSqliteMigrator;