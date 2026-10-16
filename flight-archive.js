/* Keep large telemetry outside leaderboard localStorage. IndexedDB failures
   fall back to the session; JSON/CSV exports remain available. */
(function (root) {
  'use strict';
  class FlightArchive {
    constructor(indexedDB = root.indexedDB) { this.indexedDB = indexedDB; this.cache = new Map(); this.persistent = false; this.opening = null; }
    open() {
      if (!this.indexedDB) return Promise.resolve(null);
      if (!this.opening) this.opening = new Promise(resolve => {
        try {
          const request = this.indexedDB.open('nerva.flight-archive.v1', 1);
          request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('flights')) request.result.createObjectStore('flights', { keyPath: 'id' }); };
          request.onsuccess = () => { this.persistent = true; resolve(request.result); };
          request.onerror = request.onblocked = () => { this.persistent = false; resolve(null); };
        } catch { this.persistent = false; resolve(null); }
      });
      return this.opening;
    }
    async save(report) {
      this.cache.set(report.id, report); const db = await this.open(); if (!db) return false;
      return new Promise(resolve => { try {
        const tx = db.transaction('flights', 'readwrite'); tx.objectStore('flights').put(report);
        tx.oncomplete = () => resolve(true); tx.onerror = tx.onabort = () => { this.persistent = false; resolve(false); };
      } catch { this.persistent = false; resolve(false); } });
    }
    async get(id) {
      if (this.cache.has(id)) return this.cache.get(id);
      const db = await this.open(); if (!db) return null;
      return new Promise(resolve => { try {
        const request = db.transaction('flights').objectStore('flights').get(id);
        request.onsuccess = () => { const r = request.result || null; if (r) this.cache.set(id, r); resolve(r); };
        request.onerror = () => resolve(null);
      } catch { resolve(null); } });
    }
    async list() {
      const db = await this.open(); if (!db) return [...this.cache.values()].sort((a, b) => b.createdAt - a.createdAt);
      return new Promise(resolve => { try {
        const request = db.transaction('flights').objectStore('flights').getAll();
        request.onsuccess = () => { const records = new Map(request.result.map(r => [r.id, r])); this.cache.forEach((r, id) => records.set(id, r)); resolve([...records.values()].sort((a, b) => b.createdAt - a.createdAt)); };
        request.onerror = () => resolve([...this.cache.values()]);
      } catch { resolve([...this.cache.values()]); } });
    }
  }
  function telemetryCSV(report) {
    const data = report.telemetry, rows = new Map(); for (const row of [...data.first60, ...data.last120]) rows.set(row[0].toFixed(6), row);
    return '\uFEFF' + data.columns.join(',') + '\r\n' + [...rows.values()].sort((a, b) => a[0] - b[0]).map(row => row.join(',')).join('\r\n');
  }
  const api = { FlightArchive, telemetryCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_ARCHIVE = api;
})(typeof window !== 'undefined' ? window : globalThis);
