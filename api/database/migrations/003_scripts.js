exports.up = function(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scripts (
      id         TEXT PRIMARY KEY,
      topic      TEXT,
      content    TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      job_id     TEXT REFERENCES jobs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scripts_job ON scripts(job_id);
    CREATE INDEX IF NOT EXISTS idx_scripts_topic ON scripts(topic);
  `);
};

exports.down = function(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_scripts_topic;
    DROP INDEX IF EXISTS idx_scripts_job;
    DROP TABLE IF EXISTS scripts;
  `);
};