/* Gameplay reliability calibration. Damage is a component fraction (0..1),
   not a validated pressure-vessel or turbopump reliability prediction. */
(function (root) {
  'use strict';
  const PRESSURE = Object.freeze({ yellow: 13, orange: 14, red: 15, fault: 15.5, interval: 5, chartMax: 20 });
  const DAMAGE_BANDS = Object.freeze([[.005, .05], [.05, .25], [.2, .7]].map(Object.freeze));
  const clamp = x => Math.max(0, Math.min(1, x));
  const probability = p => p < PRESSURE.fault ? 0 : 1 - .92 * Math.exp(-(p - PRESSURE.fault) / 2.5);
  const damage = (strike, roll) => { const [lo, hi] = DAMAGE_BANDS[Math.min(2, Math.max(0, strike - 1))]; return lo + (hi - lo) * clamp(roll); };
  const severity = d => d >= .65 ? 3 : d >= .15 ? 2 : d > 0 ? 1 : 0;
  const labels = Object.freeze(['正常', '降级', '故障', '失效']);
  const api = { PRESSURE, DAMAGE_BANDS, probability, damage, severity, labels };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_RELIABILITY = api;
})(typeof window !== 'undefined' ? window : globalThis);
