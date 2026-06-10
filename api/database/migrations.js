const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

class MigrationManager {
  constructor(db) {
    this.db = db;
  }

  ensureMigrationsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  getAppliedMigrations() {
    const rows = this.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    return new Map(rows.map(row => [row.version, row.name]));
  }

  getAvailableMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.js'))
      .sort();

    return files.map(f => {
      const match = f.match(/^(\d+)_(.+)\.js$/);
      if (!match) return null;
      
      return {
        version: parseInt(match[1]),
        name: match[2],
        path: path.join(MIGRATIONS_DIR, f)
      };
    }).filter(Boolean);
  }

  getPendingMigrations() {
    const applied = this.getAppliedMigrations();
    const available = this.getAvailableMigrations();

    return available.filter(m => !applied.has(m.version));
  }

  migrate({ upTo = null, dryRun = false } = {}) {
    this.ensureMigrationsTable();

    const pending = this.getPendingMigrations();
    
    if (pending.length === 0) {
      console.log('No pending migrations');
      return { migrated: [], status: 'up-to-date' };
    }

    const toRun = upTo !== null 
      ? pending.filter(m => m.version <= upTo)
      : pending;

    if (dryRun) {
      console.log('Dry run. Would apply migrations:', toRun.map(m => `${m.version}_${m.name}`));
      return { migrated: toRun, status: 'dry-run' };
    }

    const migrated = [];

    for (const migration of toRun) {
      try {
        this.db.exec('BEGIN TRANSACTION');

        const migrationFn = require(migration.path);
        migrationFn.up(this.db);

        this.db.prepare(
          'INSERT INTO schema_migrations (version, name) VALUES (?, ?)'
        ).run(migration.version, migration.name);

        this.db.exec('COMMIT');

        console.log(`Applied migration: ${migration.version}_${migration.name}`);
        migrated.push(migration);

        delete require.cache[require.resolve(migration.path)];
      } catch (error) {
        this.db.exec('ROLLBACK');
        console.error(`Failed to apply migration ${migration.version}_${migration.name}:`, error);
        throw error;
      }
    }

    return { migrated, status: 'success' };
  }

  rollback({ downTo = null, steps = 1, dryRun = false } = {}) {
    this.ensureMigrationsTable();

    const applied = this.getAppliedMigrations();
    const available = this.getAvailableMigrations();

    if (applied.size === 0) {
      console.log('No migrations to rollback');
      return { rolledBack: [], status: 'no-migrations' };
    }

    const appliedVersions = Array.from(applied.keys()).sort((a, b) => b - a);

    let targetVersion = downTo !== null ? downTo : appliedVersions[Math.min(steps, appliedVersions.length) - 1];

    const toRollback = appliedVersions.filter(v => v > targetVersion);

    if (toRollback.length === 0) {
      console.log('No migrations to rollback');
      return { rolledBack: [], status: 'up-to-date' };
    }

    if (dryRun) {
      console.log('Dry run. Would rollback migrations:', toRollback.map(v => `${v}_${applied.get(v)}`));
      return { rolledBack: toRollback.map(v => ({ version: v, name: applied.get(v) })), status: 'dry-run' };
    }

    const rolledBack = [];

    for (const version of toRollback) {
      const migrationName = applied.get(version);
      const migrationPath = path.join(MIGRATIONS_DIR, `${version}_${migrationName}.js`);

      if (!fs.existsSync(migrationPath)) {
        console.warn(`Migration file not found: ${migrationPath}, skipping`);
        continue;
      }

      try {
        this.db.exec('BEGIN TRANSACTION');

        const migrationFn = require(migrationPath);
        migrationFn.down(this.db);

        this.db.prepare(
          'DELETE FROM schema_migrations WHERE version = ?'
        ).run(version);

        this.db.exec('COMMIT');

        console.log(`Rolled back migration: ${version}_${migrationName}`);
        rolledBack.push({ version, name: migrationName });

        delete require.cache[require.resolve(migrationPath)];
      } catch (error) {
        this.db.exec('ROLLBACK');
        console.error(`Failed to rollback migration ${version}_${migrationName}:`, error);
        throw error;
      }
    }

    return { rolledBack, status: 'success' };
  }

  getCurrentVersion() {
    this.ensureMigrationsTable();
    const row = this.db.prepare('SELECT MAX(version) as version FROM schema_migrations').get();
    return row ? row.version : 0;
  }

  reset() {
    const applied = this.getAppliedMigrations();
    if (applied.size > 0) {
      return this.rollback({ downTo: 0 });
    }
    return { rolledBack: [], status: 'no-migrations' };
  }
}

module.exports = MigrationManager;