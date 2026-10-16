(function (root) {
  'use strict';
  const release = typeof module !== 'undefined' && module.exports ? require('./version.js') : root.NTR_RELEASE;
  const KEY = 'nerva.leaderboard.' + release.version;
  const FIELDS = ['id', 'version', 'scoreSchema', 'type', 'propellant', 'total', 'deltaV', 'elapsed', 'initialFuel', 'fuel',
    'diameter', 'engineModel', 'ratedPower', 'dryMass', 'initialMass', 'finalMass', 'consumedFuel', 'launchDemand', 'launchValve',
    'flightId', 'engineMass', 'meanThrust', 'burnMeanThrust', 'totalImpulse', 'burnTime', 'effectiveIsp', 'peakShipThrustWeight', 'peakEngineThrustWeight',
    'target', 'distance', 'integrity', 'temperature', 'peakAcceleration', 'peakThrust', 'peakPower', 'peakIsp', 'peakTemperature', 'peakPressure', 'peakFlow', 'reason',
    'base', 'basePoints', 'dvPoints', 'fuelPoints', 'fuelUnitCost', 'loadingCost', 'error', 'errorPenalty', 'timePenalty', 'durabilityPenalty', 'errorDeduction', 'timeDeduction', 'durabilityDeduction',
    'baseDryMass', 'payload', 'payloadPoints', 'payloadUnitReward', 'initialOxygen', 'oxygen', 'consumedOxygen', 'initialVolume', 'dividerVolume', 'primaryLoadingCost', 'oxygenLoadingCost', 'launchOxygenValve', 'peakAfterburnerPower', 'peakTotalPower', 'peakOxygenFlow', 'peakNozzleTemperature', 'peakWallTemperature', 'peakHeatLoad', 'peakDissociationPower'];
  const NUMERIC_FIELDS = FIELDS.filter(key => !['id', 'version', 'scoreSchema', 'type', 'propellant', 'engineModel', 'target', 'reason', 'flightId'].includes(key));
  const snapshot = record => Object.freeze(Object.fromEntries(FIELDS.map(key => [key, record[key]])));
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
      && ['precision', 'endurance', 'lunar'].includes(record.type) && ['hydrogen', 'water'].includes(record.propellant)
      && NUMERIC_FIELDS.every(key => Number.isFinite(record[key]) && record[key] >= 0)
      && typeof record.engineModel === 'string' && /^(NTR-II|LANTR)-\d{3}[HW]$/.test(record.engineModel)
      && typeof record.flightId === 'string' && record.flightId.length < 100
      && typeof record.reason === 'string' && record.reason.length < 200
      && (record.target === null || Number.isFinite(record.target)) && record.diameter >= .8 && record.diameter <= 2.4
      && Number.isInteger(record.total) && record.fuel <= record.initialFuel && record.oxygen <= record.initialOxygen && record.initialVolume <= 150 + 1e-8;
  }
  class NTRLeaderboard {
    constructor(storage) {
      this.storage = storage; this.records = []; this.persistent = Boolean(storage);
      if (storage) {
        try { const saved = JSON.parse(storage.getItem(KEY) || '[]'); if (Array.isArray(saved)) this.records = retainBest(saved.filter(valid).map(snapshot)); }
        catch { this.persistent = false; }
      }
    }
    add(result) {
      if (!valid(result) || this.records.some(record => record.id === result.id)) return false;
      this.records.push(snapshot(result));
      this.records = retainBest(this.records);
      try { if (this.storage) { this.storage.setItem(KEY, JSON.stringify(this.records)); this.persistent = true; } }
      catch { this.persistent = false; }
      return true;
    }
    top(type, propellant = 'all', limit = 10) {
      return this.records.filter(record => record.type === type && (propellant === 'all' || record.propellant === propellant))
        .sort(compare).slice(0, limit);
    }
    get(id) { return this.records.find(record => record.id === id) || null; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { NTRLeaderboard, LEADERBOARD_KEY: KEY };
  else root.NTRLeaderboard = NTRLeaderboard;
})(typeof window !== 'undefined' ? window : globalThis);
