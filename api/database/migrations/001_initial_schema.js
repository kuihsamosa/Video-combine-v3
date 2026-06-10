exports.up = function(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
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

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run_at) WHERE enabled = 1;
  `);
};

exports.down = function(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_jobs_next_run;
    DROP INDEX IF EXISTS idx_jobs_status;
    DROP TABLE IF EXISTS jobs;
  `);
};