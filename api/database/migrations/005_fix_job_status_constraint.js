// Migration 005: widen status values to match scheduler code
// Scheduler uses 'idle'/'running'/'error'; original schema had 'queued'/'completed'/'failed'/'cancelled'
module.exports = {
  version: 5,
  name: 'fix_job_status_constraint',
  up(db) {
    // Collect current columns
    const existingCols = db.pragma('table_info(jobs)').map(c => c.name);

    // Recreate jobs table without CHECK constraint so any status value is accepted
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs_v2 (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        topic       TEXT,
        config      TEXT,
        status      TEXT DEFAULT 'idle',
        enabled     INTEGER DEFAULT 1,
        schedule    TEXT,
        next_run_at TEXT,
        created_at  TEXT,
        updated_at  TEXT,
        last_run_id TEXT
      )
    `);

    // Copy existing rows, normalising legacy status values
    db.exec(`
      INSERT OR IGNORE INTO jobs_v2 (id, name, topic, config, status, enabled, schedule, next_run_at, created_at, updated_at, last_run_id)
      SELECT id, name, topic, config,
        CASE status
          WHEN 'queued'    THEN 'idle'
          WHEN 'completed' THEN 'idle'
          WHEN 'failed'    THEN 'error'
          WHEN 'cancelled' THEN 'idle'
          ELSE status
        END,
        enabled, schedule, next_run_at, created_at, updated_at, last_run_id
      FROM jobs
    `);

    db.exec('DROP TABLE jobs');
    db.exec('ALTER TABLE jobs_v2 RENAME TO jobs');

    // Re-add extra columns — only those that don't exist yet
    const add = (col, def) => {
      const current = db.pragma('table_info(jobs)').map(c => c.name);
      if (!current.includes(col)) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${def}`);
    };

    add('niche',                  'TEXT');
    add('platform',               "TEXT DEFAULT 'YouTube'");
    add('goal',                   "TEXT DEFAULT 'grow audience'");
    add('tone',                   "TEXT DEFAULT 'calm'");
    add('style',                  "TEXT DEFAULT 'storytelling'");
    add('duration_minutes',       'INTEGER DEFAULT 2');
    add('orientation',            "TEXT DEFAULT 'landscape'");
    add('voice',                  "TEXT DEFAULT 'narrator_warm'");
    add('speed',                  'REAL DEFAULT 0.92');
    add('model',                  "TEXT DEFAULT 'llama-3.3-70b-versatile'");
    add('clips_per_scene',        'INTEGER DEFAULT 2');
    add('use_youtube',            'INTEGER DEFAULT 0');
    add('use_pexels',             'INTEGER DEFAULT 1');
    add('use_pixabay',            'INTEGER DEFAULT 1');
    add('podcast_host_voice',     'TEXT');
    add('podcast_guest_voice',    'TEXT');
    add('auto_captions',          'INTEGER DEFAULT 0');
    add('caption_template',       'TEXT');
    add('color_grade',            'INTEGER DEFAULT 1');
    add('title_cards',            'INTEGER DEFAULT 1');
    add('cut_duration_seconds',   'REAL DEFAULT 2.5');
    add('tts_provider',           "TEXT DEFAULT 'omnivoice'");
    add('auto_loop',              'INTEGER DEFAULT 0');
    add('background_music',       'INTEGER DEFAULT 0');
    add('music_volume',           'REAL DEFAULT 0.15');
    add('multi_format_export',    'INTEGER DEFAULT 0');
    add('webhook_url',            'TEXT');
    add('intro_clip',             'TEXT');
    add('outro_clip',             'TEXT');
    add('hook_ab_test',           'INTEGER DEFAULT 0');
    add('talking_head_path',      'TEXT');
    add('pip_size',               'INTEGER DEFAULT 280');
    add('pip_corner',             "TEXT DEFAULT 'br'");
    add('youtube_auto_upload',    'INTEGER DEFAULT 0');
    add('youtube_privacy',        "TEXT DEFAULT 'private'");
    add('youtube_title',          'TEXT');
    add('youtube_description',    'TEXT');
    add('youtube_tags',           'TEXT');
    add('auto_lower_thirds',      'INTEGER DEFAULT 0');
    add('tiktok_auto_post',       'INTEGER DEFAULT 0');
    add('tiktok_privacy',         "TEXT DEFAULT 'SELF_ONLY'");
    add('tiktok_title',           'TEXT');
    add('instagram_auto_post',    'INTEGER DEFAULT 0');
    add('instagram_caption',      'TEXT');
    add('public_video_url',       'TEXT');
    add('steps',                  'TEXT');
    add('next_run_ms',            'INTEGER');
    add('last_run',               'TEXT');
    add('run_history',            'TEXT');
    add('current_run_id',        'TEXT');
    add('cached_script',          'TEXT');
    add('last_youtube_video_id',  'TEXT');
    add('last_youtube_upload_at', 'TEXT');
    add('youtube_stats',          'TEXT');
    add('youtube_stats_fetched',  'INTEGER DEFAULT 0');
    add('retry_count',            'INTEGER DEFAULT 0');
    add('from_planner',           'INTEGER DEFAULT 0');
    add('planner_idea_id',        'TEXT');
  },
  down() {},
};
