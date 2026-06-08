// #22 Script Versioning — persists every generated script with job metadata.
// Stored as individual JSON files in scripts/ directory for easy browsing.

const fs   = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname, '../scripts');

function ensureDir() {
  if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}

// Save a script version. Returns the saved record.
function saveScript({ jobId, jobName, runId, script }) {
  ensureDir();
  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const slug    = (jobName || jobId || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
  const fname   = `${slug}_${ts}_${runId || 'x'}.json`;
  const record  = {
    id:         fname.replace('.json', ''),
    job_id:     jobId,
    job_name:   jobName,
    run_id:     runId,
    saved_at:   new Date().toISOString(),
    title:      script?.title || '(untitled)',
    word_count: (script?.narration || '').split(/\s+/).filter(Boolean).length,
    scene_count: (script?.scenes || []).length,
    script,
  };
  fs.writeFileSync(path.join(SCRIPTS_DIR, fname), JSON.stringify(record, null, 2));
  return record;
}

// List all saved scripts, newest first
function listScripts({ jobId } = {}) {
  ensureDir();
  return fs.readdirSync(SCRIPTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'));
        return r;
      } catch (_) { return null; }
    })
    .filter(r => r && (!jobId || r.job_id === jobId))
    .sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));
}

function getScript(id) {
  ensureDir();
  const fp = path.join(SCRIPTS_DIR, id + '.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; }
}

function deleteScript(id) {
  const fp = path.join(SCRIPTS_DIR, id + '.json');
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); return true; } catch (_) { return false; }
}

module.exports = { saveScript, listScripts, getScript, deleteScript, SCRIPTS_DIR };
