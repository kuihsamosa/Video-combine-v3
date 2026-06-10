const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DatabaseClient {
  constructor(dbPath = null) {
    this.dbPath = dbPath || path.join(__dirname, '../../database/app.db');
    this.db = null;
  }

  connect() {
    if (this.db) return this.db;

    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(this.dbPath, { 
      verbose: process.env.DB_VERBOSE === 'true' ? console.log : null 
    });

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    return this.db;
  }

  disconnect() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getConnection() {
    if (!this.db) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.db;
  }

  transaction(fn) {
    return this.getConnection().transaction(fn);
  }

  exec(sql) {
    return this.getConnection().exec(sql);
  }

  prepare(sql) {
    return this.getConnection().prepare(sql);
  }

  beginTransaction() {
    this.getConnection().exec('BEGIN TRANSACTION');
  }

  commit() {
    this.getConnection().exec('COMMIT');
  }

  rollback() {
    this.getConnection().exec('ROLLBACK');
  }

  close() {
    this.disconnect();
  }
}

module.exports = DatabaseClient;