const DatabaseClient = require('./client');
const MigrationManager = require('./migrations');
const Job = require('../models/Job');
const JobRun = require('../models/JobRun');
const Script = require('../models/Script');

class DatabaseStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || process.env.DB_PATH || './database/app.db';
    this.client = new DatabaseClient(this.dbPath);
    this.migrationManager = null;
    this.job = null;
    this.jobRun = null;
    this.script = null;
    this.isConnected = false;
  }

  connect() {
    if (this.isConnected) {
      return this;
    }

    this.client.connect();
    this.migrationManager = new MigrationManager(this.client.getConnection());
    
    this.migrationManager.migrate();

    this.job = new Job(this.client);
    this.jobRun = new JobRun(this.client);
    this.script = new Script(this.client);

    this.isConnected = true;
    return this;
  }

  disconnect() {
    this.client.disconnect();
    this.isConnected = false;
    return this;
  }

  transaction(fn) {
    return this.client.transaction(fn);
  }

  beginTransaction() {
    this.client.beginTransaction();
  }

  commit() {
    this.client.commit();
  }

  rollback() {
    this.client.rollback();
  }

  getMigrationStatus() {
    return {
      currentVersion: this.migrationManager.getCurrentVersion(),
      pendingMigrations: this.migrationManager.getPendingMigrations().length
    };
  }

  migrate(options = {}) {
    return this.migrationManager.migrate(options);
  }

  rollback(options = {}) {
    return this.migrationManager.rollback(options);
  }

  reset() {
    return this.migrationManager.reset();
  }
}

module.exports = DatabaseStore;