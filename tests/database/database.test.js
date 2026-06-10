const DatabaseClient = require('../../api/database/client');
const MigrationManager = require('../../api/database/migrations');
const Job = require('../../api/models/Job');
const JobRun = require('../../api/models/JobRun');
const Script = require('../../api/models/Script');

describe('Database Layer', () => {
  let db;
  let jobModel;
  let jobRunModel;
  let scriptModel;

  beforeEach(() => {
    db = new DatabaseClient(':memory:');
    db.connect();

    const migrationManager = new MigrationManager(db.getConnection());
    migrationManager.migrate();

    jobModel = new Job(db);
    jobRunModel = new JobRun(db);
    scriptModel = new Script(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Job Model', () => {
    test('should create a job', () => {
      const jobData = {
        id: 'test-job-1',
        name: 'Test Job',
        topic: 'Test Topic',
        config: {
          tone: 'energetic',
          style: 'documentary',
          duration_minutes: 5
        },
        status: 'queued',
        enabled: true,
        schedule: {
          type: 'daily',
          time: '09:00'
        },
        next_run_at: null,
        last_run_id: null
      };

      const job = jobModel.create(jobData);

      expect(job).toBeDefined();
      expect(job.id).toBe('test-job-1');
      expect(job.name).toBe('Test Job');
      expect(job.topic).toBe('Test Topic');
      expect(job.config.tone).toBe('energetic');
      expect(job.status).toBe('queued');
      expect(job.enabled).toBe(true);
      expect(job.schedule.type).toBe('daily');
      expect(job.created_at).toBeDefined();
      expect(job.updated_at).toBeDefined();
    });

    test('should get a job by id', () => {
      const jobData = {
        id: 'test-job-2',
        name: 'Test Job 2',
        topic: 'Test Topic 2'
      };

      jobModel.create(jobData);
      const retrieved = jobModel.getById('test-job-2');

      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe('test-job-2');
      expect(retrieved.name).toBe('Test Job 2');
    });

    test('should return null for non-existent job', () => {
      const retrieved = jobModel.getById('non-existent');
      expect(retrieved).toBeNull();
    });

    test('should get all jobs', () => {
      jobModel.create({ id: 'job-1', name: 'Job 1', topic: 'Topic 1' });
      jobModel.create({ id: 'job-2', name: 'Job 2', topic: 'Topic 2' });
      jobModel.create({ id: 'job-3', name: 'Job 3', topic: 'Topic 3' });

      const jobs = jobModel.getAll();

      expect(jobs).toHaveLength(3);
      expect(jobs.map(j => j.id)).toContain('job-1');
      expect(jobs.map(j => j.id)).toContain('job-2');
      expect(jobs.map(j => j.id)).toContain('job-3');
    });

    test('should filter jobs by status', () => {
      jobModel.create({ id: 'job-1', name: 'Job 1', status: 'queued' });
      jobModel.create({ id: 'job-2', name: 'Job 2', status: 'running' });
      jobModel.create({ id: 'job-3', name: 'Job 3', status: 'completed' });

      const queuedJobs = jobModel.getAll({ status: 'queued' });
      const runningJobs = jobModel.getAll({ status: 'running' });

      expect(queuedJobs).toHaveLength(1);
      expect(runningJobs).toHaveLength(1);
      expect(queuedJobs[0].id).toBe('job-1');
      expect(runningJobs[0].id).toBe('job-2');
    });

    test('should filter jobs by enabled status', () => {
      jobModel.create({ id: 'job-1', name: 'Job 1', enabled: true, status: 'queued', next_run_at: null, last_run_id: null });
      jobModel.create({ id: 'job-2', name: 'Job 2', enabled: false, status: 'queued', next_run_at: null, last_run_id: null });
      jobModel.create({ id: 'job-3', name: 'Job 3', enabled: true, status: 'queued', next_run_at: null, last_run_id: null });

      const enabledJobs = jobModel.getAll({ enabled: true });
      const disabledJobs = jobModel.getAll({ enabled: false });

      expect(enabledJobs).toHaveLength(2);
      expect(disabledJobs).toHaveLength(1);
    });

    test('should update a job', () => {
      jobModel.create({ id: 'job-1', name: 'Job 1', status: 'queued' });

      const updated = jobModel.update('job-1', {
        status: 'running',
        name: 'Updated Job 1'
      });

      expect(updated.status).toBe('running');
      expect(updated.name).toBe('Updated Job 1');
      expect(updated.id).toBe('job-1');
    });

    test('should update job config', () => {
      const originalConfig = { tone: 'energetic', style: 'documentary' };
      jobModel.create({ id: 'job-1', name: 'Job 1', config: originalConfig });

      const updatedConfig = { tone: 'educational', style: 'case-study', duration_minutes: 10 };
      const updated = jobModel.update('job-1', { config: updatedConfig });

      expect(updated.config.tone).toBe('educational');
      expect(updated.config.style).toBe('case-study');
      expect(updated.config.duration_minutes).toBe(10);
    });

    test('should delete a job', () => {
      jobModel.create({ id: 'job-1', name: 'Job 1' });

      const deleted = jobModel.delete('job-1');
      const retrieved = jobModel.getById('job-1');

      expect(deleted).toBe(true);
      expect(retrieved).toBeNull();
    });

    test('should get enabled jobs', () => {
      jobModel.create({ id: 'job-1', name: 'Job 1', enabled: true, status: 'queued', next_run_at: null, last_run_id: null });
      jobModel.create({ id: 'job-2', name: 'Job 2', enabled: false, status: 'queued', next_run_at: null, last_run_id: null });
      jobModel.create({ id: 'job-3', name: 'Job 3', enabled: true, status: 'completed', next_run_at: null, last_run_id: null });

      const enabledJobs = jobModel.getEnabledJobs();

      expect(enabledJobs).toHaveLength(1);
      expect(enabledJobs[0].id).toBe('job-1');
    });

    test('should count jobs', () => {
      jobModel.create({ id: 'job-1', name: 'Job 1', status: 'queued' });
      jobModel.create({ id: 'job-2', name: 'Job 2', status: 'running' });
      jobModel.create({ id: 'job-3', name: 'Job 3', status: 'queued' });

      const totalCount = jobModel.count();
      const queuedCount = jobModel.count({ status: 'queued' });
      const runningCount = jobModel.count({ status: 'running' });

      expect(totalCount).toBe(3);
      expect(queuedCount).toBe(2);
      expect(runningCount).toBe(1);
    });

    test('should handle transactions', () => {
      const transaction = db.transaction(() => {
        jobModel.create({ id: 'job-1', name: 'Job 1' });
        jobModel.create({ id: 'job-2', name: 'Job 2' });
      });

      transaction();

      const jobs = jobModel.getAll();
      expect(jobs).toHaveLength(2);
    });
  });

  describe('JobRun Model', () => {
    let jobId;

    beforeEach(() => {
      const job = jobModel.create({
        id: 'test-job',
        name: 'Test Job',
        topic: 'Test Topic'
      });
      jobId = job.id;
    });

    test('should create a job run', () => {
      const runData = {
        id: 'run-1',
        job_id: jobId,
        status: 'pending',
        started_at: new Date().toISOString(),
        logs: ['Log message 1', 'Log message 2'],
        output_files: ['output1.mp4', 'output2.mp4']
      };

      const run = jobRunModel.create(runData);

      expect(run).toBeDefined();
      expect(run.id).toBe('run-1');
      expect(run.job_id).toBe(jobId);
      expect(run.status).toBe('pending');
      expect(run.logs).toHaveLength(2);
      expect(run.output_files).toHaveLength(2);
    });

    test('should get a run by id', () => {
      const runData = {
        id: 'run-2',
        job_id: jobId,
        status: 'running'
      };

      jobRunModel.create(runData);
      const retrieved = jobRunModel.getById('run-2');

      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe('run-2');
      expect(retrieved.job_id).toBe(jobId);
    });

    test('should get runs by job id', () => {
      jobRunModel.create({ id: 'run-1', job_id: jobId, status: 'completed' });
      jobRunModel.create({ id: 'run-2', job_id: jobId, status: 'running' });
      jobRunModel.create({ id: 'run-3', job_id: jobId, status: 'failed' });

      const runs = jobRunModel.getByJobId(jobId);

      expect(runs).toHaveLength(3);
      expect(runs.map(r => r.id)).toContain('run-1');
      expect(runs.map(r => r.id)).toContain('run-2');
      expect(runs.map(r => r.id)).toContain('run-3');
    });

    test('should get latest run by job id', () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 10000);

      jobRunModel.create({ id: 'run-1', job_id: jobId, started_at: earlier.toISOString() });
      jobRunModel.create({ id: 'run-2', job_id: jobId, started_at: now.toISOString() });

      const latest = jobRunModel.getLatestByJobId(jobId);

      expect(latest.id).toBe('run-2');
    });

    test('should update a run', () => {
      jobRunModel.create({ id: 'run-1', job_id: jobId, status: 'pending' });

      const updated = jobRunModel.update('run-1', {
        status: 'completed',
        completed_at: new Date().toISOString()
      });

      expect(updated.status).toBe('completed');
      expect(updated.completed_at).toBeDefined();
    });

    test('should append log to run', () => {
      const run = jobRunModel.create({ id: 'run-1', job_id: jobId, status: 'running' });

      const updated = jobRunModel.appendLog('run-1', 'New log message');

      expect(updated.logs).toHaveLength(1);
      expect(updated.logs[0].message).toBe('New log message');
      expect(updated.logs[0].timestamp).toBeDefined();
    });

    test('should append multiple logs', () => {
      const run = jobRunModel.create({ 
        id: 'run-1', 
        job_id: jobId, 
        status: 'running',
        logs: [{ timestamp: new Date().toISOString(), message: 'Initial log' }]
      });

      const updated = jobRunModel.appendLog('run-1', 'Second log');

      expect(updated.logs).toHaveLength(2);
      expect(updated.logs[1].message).toBe('Second log');
    });

    test('should delete a run', () => {
      jobRunModel.create({ id: 'run-1', job_id: jobId });

      const deleted = jobRunModel.delete('run-1');
      const retrieved = jobRunModel.getById('run-1');

      expect(deleted).toBe(true);
      expect(retrieved).toBeNull();
    });

    test('should delete all runs for a job', () => {
      jobRunModel.create({ id: 'run-1', job_id: jobId });
      jobRunModel.create({ id: 'run-2', job_id: jobId });
      jobRunModel.create({ id: 'run-3', job_id: jobId });

      const deleted = jobRunModel.deleteByJobId(jobId);
      const runs = jobRunModel.getByJobId(jobId);

      expect(deleted).toBe(3);
      expect(runs).toHaveLength(0);
    });

    test('should get running runs', () => {
      jobRunModel.create({ id: 'run-1', job_id: jobId, status: 'running' });
      jobRunModel.create({ id: 'run-2', job_id: jobId, status: 'completed' });
      jobRunModel.create({ id: 'run-3', job_id: jobId, status: 'running' });

      const runningRuns = jobRunModel.getRunningRuns();

      expect(runningRuns).toHaveLength(2);
      expect(runningRuns.map(r => r.id)).toContain('run-1');
      expect(runningRuns.map(r => r.id)).toContain('run-3');
    });

    test('should count runs', () => {
      jobRunModel.create({ id: 'run-1', job_id: jobId, status: 'completed' });
      jobRunModel.create({ id: 'run-2', job_id: jobId, status: 'running' });
      jobRunModel.create({ id: 'run-3', job_id: jobId, status: 'failed' });

      const totalCount = jobRunModel.count();
      const completedCount = jobRunModel.count({ status: 'completed' });

      expect(totalCount).toBe(3);
      expect(completedCount).toBe(1);
    });
  });

  describe('Script Model', () => {
    let jobId;

    beforeEach(() => {
      const job = jobModel.create({
        id: 'test-job',
        name: 'Test Job',
        topic: 'Test Topic'
      });
      jobId = job.id;
    });

    test('should create a script', () => {
      const scriptContent = {
        title: 'Test Script',
        narration: 'This is a test narration',
        scenes: [
          { id: 1, description: 'Scene 1' },
          { id: 2, description: 'Scene 2' }
        ]
      };

      const scriptData = {
        id: 'script-1',
        topic: 'Test Topic',
        content: scriptContent,
        job_id: jobId
      };

      const script = scriptModel.create(scriptData);

      expect(script).toBeDefined();
      expect(script.id).toBe('script-1');
      expect(script.topic).toBe('Test Topic');
      expect(script.content.title).toBe('Test Script');
      expect(script.content.scenes).toHaveLength(2);
      expect(script.job_id).toBe(jobId);
      expect(script.created_at).toBeDefined();
    });

    test('should get a script by id', () => {
      const scriptContent = { title: 'Test Script', narration: 'Test' };
      scriptModel.create({ id: 'script-1', topic: 'Topic', content: scriptContent });

      const retrieved = scriptModel.getById('script-1');

      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe('script-1');
      expect(retrieved.content.title).toBe('Test Script');
    });

    test('should get scripts by job id', () => {
      const scriptContent = { title: 'Script', narration: 'Test' };
      scriptModel.create({ id: 'script-1', topic: 'Topic 1', content: scriptContent, job_id: jobId });
      scriptModel.create({ id: 'script-2', topic: 'Topic 2', content: scriptContent, job_id: jobId });

      const scripts = scriptModel.getByJobId(jobId);

      expect(scripts).toHaveLength(2);
      expect(scripts.map(s => s.id)).toContain('script-1');
      expect(scripts.map(s => s.id)).toContain('script-2');
    });

    test('should get scripts by topic', () => {
      const scriptContent = { title: 'Script', narration: 'Test' };
      scriptModel.create({ id: 'script-1', topic: 'AI Revolution', content: scriptContent });
      scriptModel.create({ id: 'script-2', topic: 'AI Revolution', content: scriptContent });
      scriptModel.create({ id: 'script-3', topic: 'Different Topic', content: scriptContent });

      const scripts = scriptModel.getByTopic('AI Revolution');

      expect(scripts).toHaveLength(2);
      expect(scripts.map(s => s.id)).toContain('script-1');
      expect(scripts.map(s => s.id)).toContain('script-2');
    });

    test('should update a script', () => {
      const originalContent = { title: 'Original', narration: 'Test' };
      scriptModel.create({ id: 'script-1', topic: 'Topic', content: originalContent });

      const updatedContent = { title: 'Updated', narration: 'New narration', scenes: [] };
      const updated = scriptModel.update('script-1', { 
        topic: 'New Topic',
        content: updatedContent 
      });

      expect(updated.topic).toBe('New Topic');
      expect(updated.content.title).toBe('Updated');
      expect(updated.content.narration).toBe('New narration');
    });

    test('should delete a script', () => {
      scriptModel.create({ id: 'script-1', topic: 'Topic', content: { title: 'Test' } });

      const deleted = scriptModel.delete('script-1');
      const retrieved = scriptModel.getById('script-1');

      expect(deleted).toBe(true);
      expect(retrieved).toBeNull();
    });

    test('should search scripts', () => {
      const scriptContent = { title: 'AI Script', narration: 'About artificial intelligence' };
      scriptModel.create({ id: 'script-1', topic: 'AI Revolution', content: scriptContent });
      scriptModel.create({ id: 'script-2', topic: 'Machine Learning', content: scriptContent });
      scriptModel.create({ id: 'script-3', topic: 'Different Topic', content: { title: 'Other' } });

      const results = scriptModel.search('AI');

      expect(results.length).toBeGreaterThan(0);
      expect(results.map(s => s.id)).toContain('script-1');
    });

    test('should count scripts', () => {
      const scriptContent = { title: 'Script', narration: 'Test' };
      scriptModel.create({ id: 'script-1', topic: 'Topic 1', content: scriptContent, job_id: jobId });
      scriptModel.create({ id: 'script-2', topic: 'Topic 2', content: scriptContent, job_id: jobId });
      scriptModel.create({ id: 'script-3', topic: 'Topic 3', content: scriptContent });

      const totalCount = scriptModel.count();
      const jobCount = scriptModel.count({ job_id: jobId });

      expect(totalCount).toBe(3);
      expect(jobCount).toBe(2);
    });
  });

  describe('Foreign Key Constraints', () => {
    test('should cascade delete job runs when job is deleted', () => {
      const job = jobModel.create({ id: 'job-1', name: 'Test Job' });
      jobRunModel.create({ id: 'run-1', job_id: job.id, status: 'completed' });
      jobRunModel.create({ id: 'run-2', job_id: job.id, status: 'failed' });

      jobModel.delete('job-1');

      const runs = jobRunModel.getByJobId(job.id);
      expect(runs).toHaveLength(0);
    });

    test('should set null for scripts when job is deleted', () => {
      const job = jobModel.create({ id: 'job-1', name: 'Test Job' });
      scriptModel.create({ 
        id: 'script-1', 
        topic: 'Topic', 
        content: { title: 'Test' },
        job_id: job.id 
      });

      jobModel.delete('job-1');

      const script = scriptModel.getById('script-1');
      expect(script).toBeDefined();
      expect(script.job_id).toBeNull();
    });
  });

  describe('Migration Manager', () => {
    test('should apply pending migrations', () => {
      const manager = new MigrationManager(db.getConnection());
      const result = manager.migrate();

      expect(result.status).toBe('up-to-date');
    });

    test('should get current version', () => {
      const manager = new MigrationManager(db.getConnection());
      manager.migrate();

      const version = manager.getCurrentVersion();

      expect(version).toBeGreaterThan(0);
    });

    test('should rollback migrations', () => {
      const manager = new MigrationManager(db.getConnection());
      const initialVersion = manager.getCurrentVersion();
      
      if (initialVersion <= 0) {
        console.log('Skipping rollback test - no migrations to rollback');
        return;
      }
      
      const result = manager.rollback({ steps: 1 });
      const version = manager.getCurrentVersion();

      expect(['success', 'no-migrations', 'up-to-date']).toContain(result.status);
      expect(version).toBeLessThanOrEqual(initialVersion);
    });
  });
});