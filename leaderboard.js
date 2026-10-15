(function (root) {
  'use strict';
  const release = typeof module !== 'undefined' && module.exports ? require('./version.js') : root.NTR_RELEASE;
  const KEY = 'nerva.leaderboard.' + release.version;
  const compare = (a, b) => b.total - a.total || a.elapsed - b.elapsed || a.id.localeCompare(b.id);
  function retainBest(records) {
    const counts = {};
    return records.sort(compare).filter(record => {
      const group = record.type + ':' + record.propellant;
      counts[group] = (counts[group] || 0) + 1;
      return counts[group] <= 50;
    });
  }
  function valid(record) {
    return record && typeof record.id === 'string' && record.id.length < 100 && record.version === release.version && record.scoreSchema === release.scoreSchema
      && ['precision', 'endurance'].includes(record.type) && ['hydrogen', 'water'].includes(record.propellant)
      && ['total', 'deltaV', 'elapsed', 'initialFuel', 'fuel'].every(key => Number.isFinite(record[key]) && record[key] >= 0)
      && Number.isInteger(record.total) && record.fuel <= record.initialFuel;
  }
  class NTRLeaderboard {
    constructor(storage) {
      this.storage = storage; this.records = []; this.persistent = Boolean(storage);
      if (storage) {
        try { const saved = JSON.parse(storage.getItem(KEY) || '[]'); if (Array.isArray(saved)) this.records = retainBest(saved.filter(valid)); }
        catch { this.persistent = false; }
      }
    }
    add(result) {
      if (!valid(result) || this.records.some(record => record.id === result.id)) return false;
      const { id, version, scoreSchema, type, propellant, total, deltaV, elapsed, initialFuel, fuel } = result;
      this.records.push({ id, version, scoreSchema, type, propellant, total, deltaV, elapsed, initialFuel, fuel });
      this.records = retainBest(this.records);
      try { if (this.storage) { this.storage.setItem(KEY, JSON.stringify(this.records)); this.persistent = true; } }
      catch { this.persistent = false; }
      return true;
    }
    top(type, propellant = 'all', limit = 10) {
      return this.records.filter(record => record.type === type && (propellant === 'all' || record.propellant === propellant))
        .sort(compare).slice(0, limit);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { NTRLeaderboard, LEADERBOARD_KEY: KEY };
  else root.NTRLeaderboard = NTRLeaderboard;
})(typeof window !== 'undefined' ? window : globalThis);
