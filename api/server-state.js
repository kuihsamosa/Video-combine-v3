// ─────────────────────────────────────────────────────────────────────────────
//  Shared mutable state between server.js and scheduler.js
//  Avoids circular require() by keeping the shared reference here.
// ─────────────────────────────────────────────────────────────────────────────

const WORKER_TIMEOUT = 30_000; // ms

/** @type {Map<string, {id:string, lastSeen:number, capacity:number, running:string[]}>} */
const _workers = new Map();

function onlineWorkerCount() {
  const now = Date.now();
  let count = 0;
  for (const w of _workers.values()) {
    if ((now - w.lastSeen) < WORKER_TIMEOUT) count++;
  }
  return count;
}

module.exports = { _workers, WORKER_TIMEOUT, onlineWorkerCount };
