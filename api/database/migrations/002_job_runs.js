exports.up = function(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id            TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status        TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      started_at    TEXT,
      completed_at  TEXT,
      logs          TEXT,
      output_files  TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_job_id ON job_runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON job_runs(status);
  `);
};

exports.down = function(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_runs_status;
    DROP INDEX IF EXISTS idx_runs_job_id;
    DROP TABLE IF EXISTS job_runs;
  `);
};