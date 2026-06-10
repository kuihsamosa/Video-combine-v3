exports.up = function(db) {
  // Get existing columns
  const existingColumns = db.prepare("PRAGMA table_info(jobs)").all()
    .map(row => row.name);
  
  console.log('Existing columns:', existingColumns);
  
  // Helper function to add column if it doesn't exist
  const addColumn = (name, type, defaultValue = null) => {
    if (!existingColumns.includes(name)) {
      let sql = `ALTER TABLE jobs ADD COLUMN ${name} ${type}`;
      if (defaultValue !== null) {
        sql += ` DEFAULT ${defaultValue}`;
      }
      console.log(`Adding column: ${name}`);
      db.exec(sql);
    } else {
      console.log(`Column ${name} already exists, skipping`);
    }
  };
  
  // Add new columns for comprehensive scheduler job configuration
  addColumn('niche', 'TEXT');
  addColumn('platform', 'TEXT', "'YouTube'");
  addColumn('goal', 'TEXT', "'grow audience'");
  addColumn('tone', 'TEXT', "'calm'");
  addColumn('style', 'TEXT', "'storytelling'");
  addColumn('duration_minutes', 'INTEGER', 2);
  addColumn('orientation', 'TEXT', "'landscape'");
  addColumn('voice', 'TEXT', "'narrator_warm'");
  addColumn('speed', 'REAL', 0.92);
  addColumn('model', 'TEXT', "'llama-3.3-70b-versatile'");
  addColumn('clips_per_scene', 'INTEGER', 2);
  addColumn('use_youtube', 'INTEGER', 0);
  addColumn('use_pexels', 'INTEGER', 1);
  addColumn('use_pixabay', 'INTEGER', 1);
  addColumn('podcast_host_voice', 'TEXT');
  addColumn('podcast_guest_voice', 'TEXT');
  addColumn('auto_captions', 'INTEGER', 0);
  addColumn('caption_template', 'TEXT');
  addColumn('color_grade', 'INTEGER', 1);
  addColumn('title_cards', 'INTEGER', 1);
  addColumn('cut_duration_seconds', 'REAL', 2.5);
  addColumn('tts_provider', 'TEXT', "'omnivoice'");
  addColumn('auto_loop', 'INTEGER', 0);
  addColumn('background_music', 'INTEGER', 0);
  addColumn('music_volume', 'REAL', 0.15);
  addColumn('multi_format_export', 'INTEGER', 0);
  addColumn('webhook_url', 'TEXT');
  addColumn('intro_clip', 'TEXT');
  addColumn('outro_clip', 'TEXT');
  addColumn('hook_ab_test', 'INTEGER', 0);
  addColumn('talking_head_path', 'TEXT');
  addColumn('pip_size', 'INTEGER', 280);
  addColumn('pip_corner', 'TEXT', "'br'");
  addColumn('youtube_auto_upload', 'INTEGER', 0);
  addColumn('youtube_privacy', 'TEXT', "'private'");
  addColumn('youtube_title', 'TEXT');
  addColumn('youtube_description', 'TEXT');
  addColumn('youtube_tags', 'TEXT');
  addColumn('auto_lower_thirds', 'INTEGER', 0);
  addColumn('tiktok_auto_post', 'INTEGER', 0);
  addColumn('tiktok_privacy', 'TEXT', "'SELF_ONLY'");
  addColumn('tiktok_title', 'TEXT');
  addColumn('instagram_auto_post', 'INTEGER', 0);
  addColumn('instagram_caption', 'TEXT');
  addColumn('public_video_url', 'TEXT');
  
  // Steps configuration
  addColumn('steps', 'TEXT');
  
  // Run tracking
  addColumn('last_run', 'TEXT');
  addColumn('next_run_ms', 'INTEGER');
  addColumn('run_history', 'TEXT');
  addColumn('current_run_id', 'TEXT');
  
  // Cache fields
  addColumn('cached_script', 'TEXT');
  
  // YouTube stats fields
  addColumn('last_youtube_video_id', 'TEXT');
  addColumn('last_youtube_upload_at', 'TEXT');
  addColumn('youtube_stats', 'TEXT');
  addColumn('youtube_stats_fetched', 'INTEGER', 0);
  
  // Retry mechanism
  addColumn('retry_count', 'INTEGER', 0);
  
  // Planner integration
  addColumn('from_planner', 'INTEGER', 0);
  addColumn('planner_idea_id', 'INTEGER');
  
  // Create indexes for performance
  const existingIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'").all()
    .map(row => row.name);
  
  const createIndexIfNotExists = (name, sql) => {
    if (!existingIndexes.includes(name)) {
      console.log(`Creating index: ${name}`);
      db.exec(sql);
    } else {
      console.log(`Index ${name} already exists, skipping`);
    }
  };
  
  createIndexIfNotExists('idx_jobs_enabled', 'CREATE INDEX idx_jobs_enabled ON jobs(enabled)');
  createIndexIfNotExists('idx_jobs_status_enabled', 'CREATE INDEX idx_jobs_status_enabled ON jobs(status, enabled)');
  createIndexIfNotExists('idx_jobs_next_run_ms', 'CREATE INDEX idx_jobs_next_run_ms ON jobs(next_run_ms) WHERE enabled = 1 AND next_run_ms IS NOT NULL');
};

exports.down = function(db) {
  // SQLite doesn't support DROP COLUMN directly, need to recreate table
  console.log('Rolling back scheduler integration migration...');
  
  // Get current data
  const jobs = db.prepare('SELECT * FROM jobs').all();
  
  // Drop table
  db.exec('DROP TABLE IF EXISTS jobs');
  
  // Recreate original table
  db.exec(`
    CREATE TABLE jobs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      topic       TEXT,
      config      TEXT,
      status      TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      enabled     INTEGER DEFAULT 1 CHECK(enabled IN (0, 1)),
      schedule    TEXT,
      next_run_at TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      last_run_id TEXT
    );
  `);
  
  // Restore original indexes
  db.exec('CREATE INDEX idx_jobs_status ON jobs(status)');
  db.exec('CREATE INDEX idx_jobs_next_run ON jobs(next_run_at) WHERE enabled = 1');
  
  // Restore data (only original columns)
  const insertStmt = db.prepare(`
    INSERT INTO jobs (id, name, topic, config, status, enabled, schedule, next_run_at, created_at, updated_at, last_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const job of jobs) {
    insertStmt.run(
      job.id, job.name, job.topic, job.config, job.status, job.enabled,
      job.schedule, job.next_run_at, job.created_at, job.updated_at, job.last_run_id
    );
  }
  
  console.log('Rollback completed');
};