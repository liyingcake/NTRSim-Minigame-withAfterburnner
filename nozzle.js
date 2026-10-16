/* Conical hardware and a finite-reaction-time sudden-freeze nozzle model.
   Equilibrium upstream of freezing, fixed composition downstream. This is a
   quasi-1D game approximation, not finite-rate CFD or a validated engine design. */
(function (root) {
  'use strict';
  const table = typeof module !== 'undefined' && module.exports ? require('./thermo-table.js') : root.NTR_THERMO_TABLE;
  const CONFIG = table.metadata.model.geometry;
  const DEFAULTS = Object.freeze({ ...CONFIG.defaults });
  const LIMITS = Object.freeze(Object.fromEntries(Object.entries(CONFIG.limits).map(([key, pair]) => [key, Object.freeze([...pair])])));
  function valid(settings) { return Object.keys(DEFAULTS).every(k => Number.isFinite(settings[k]) && settings[k] >= LIMITS[k][0] && settings[k] <= LIMITS[k][1]); }
  function geometry(diameter = 1.4, settings = DEFAULTS) {
    if (!Number.isFinite(diameter) || diameter < .8 || diameter > 2.4 || !valid(settings)) throw new TypeError('Invalid nozzle geometry');
    const scale = (diameter / 1.4) ** 2, angle = settings.halfAngle * Math.PI / 180;
    const throatArea = CONFIG.referenceThroatArea * scale * settings.throatScale, throatRadius = Math.sqrt(throatArea / Math.PI);
    const baseRadius = throatRadius * Math.sqrt(settings.expansionRatio), exitRadius = baseRadius + settings.extension * Math.tan(angle);
    const baseLength = (baseRadius - throatRadius) / Math.tan(angle), length = baseLength + settings.extension;
    const baseSurface = Math.PI * (throatRadius + baseRadius) * Math.hypot(baseLength, baseRadius - throatRadius);
    const extensionSurface = settings.extension > 0 ? Math.PI * (baseRadius + exitRadius) * Math.hypot(settings.extension, exitRadius - baseRadius) : 0;
    const baseMass = baseSurface * CONFIG.baseArealMass + CONFIG.baseHardwareMass * scale, extensionMass = extensionSurface * CONFIG.extensionArealMass + (settings.extension > 0 ? CONFIG.extensionJointMass * scale : 0);
    return { ...settings, throatArea, throatRadius, exitArea: Math.PI * exitRadius ** 2, baseRadius, exitRadius,
      baseLength, length, expansion: (exitRadius / throatRadius) ** 2, baseSurface, extensionSurface,
      surface: baseSurface + extensionSurface, baseMass, extensionMass, mass: CONFIG.supportFactor * (baseMass + extensionMass),
      divergenceEfficiency: (1 + Math.cos(angle)) / 2 };
  }
  function chamberPressure(flow, state, g) {
    if (!(flow > 0)) return 0;
    const gamma = Math.max(1.05, Math.min(1.67, state.gamma)), r = 8314.462618 / state.molarMass;
    const coefficient = Math.sqrt(gamma / (r * Math.max(20, state.temperature))) * (2 / (gamma + 1)) ** ((gamma + 1) / (2 * (gamma - 1)));
    return flow / (g.throatArea * coefficient);
  }
  function solve({ flow, h0, reference, pressure, ratio, geometry: g, efficiency = .99, expansion = 'finite' }, thermo) {
    const entropy = reference.entropy, minTableP = thermo.metadata.pressures[0];
    let frozen = null, freezePressure = null;
    const position = area => Math.max(0, (Math.sqrt(area / Math.PI) - g.throatRadius) / Math.tan(g.halfAngle * Math.PI / 180));
    function evaluate(p, useFreeze = true) {
      let ideal, offset = 0;
      if (useFreeze && frozen && p <= frozen.pressure) {
        ideal = thermo.frozenAtEntropy(frozen.entropy, p, frozen.y, frozen.temperature); offset = frozen.offset; ideal.h += offset;
      } else ideal = thermo.fromEntropy(entropy, Math.max(minTableP, p), ratio);
      const kinetic = Math.max(0, h0 - ideal.h) * efficiency, speed = Math.sqrt(2 * kinetic);
      const actual = thermo.frozenFromEnthalpy(h0 - kinetic - offset, ideal.y); actual.h += offset;
      const r = 8314.462618 / actual.molarMass, density = p / (r * Math.max(1, actual.temperature));
      const area = speed > 0 ? flow / (density * speed) : Infinity;
      return { ...actual, pressure: p, velocity: speed, kinetic, area, x: position(area),
        mach: speed / Math.sqrt(Math.max(1, actual.gamma * r * actual.temperature)), reactionTime: 10 ** (ideal.logReactionTime ?? 6) };
    }
    // Locate the critical section of the equivalent mixed stream. LANTR
    // injection is a lumped mixing station; shock/back-pressure CFD is omitted.
    let lo = Math.max(minTableP, pressure * .001), hi = Math.min(thermo.metadata.pressures.at(-1), pressure * 20);
    for (let i = 0; i < 24; i++) { const mid = Math.sqrt(lo * hi), state = evaluate(mid, false); if (state.mach > 1) lo = mid; else hi = mid; }
    const critical = evaluate(Math.sqrt(lo * hi), false);
    function freezeAt(p) {
      const eq = thermo.fromEntropy(entropy, Math.max(minTableP, p), ratio), base = thermo.frozenProperties(eq.temperature, eq.y);
      frozen = { pressure: p, temperature: eq.temperature, y: eq.y, entropy: thermo.frozenEntropy(eq.temperature, p, eq.y), offset: eq.h - base.h };
      freezePressure = p;
    }
    if (expansion === 'frozen') freezeAt(critical.pressure);
    let previous = critical, previousRatio = null, exit = null, residenceTime = 0;
    for (let i = 1; i <= 90; i++) {
      const p = critical.pressure * Math.exp(-i * .22);
      if (!frozen && (p < minTableP || expansion !== 'equilibrium' && critical.reactionTime > 1e5)) freezeAt(previous.pressure);
      let state = evaluate(p);
      const dx = Math.max(0, Math.min(g.length, state.x) - Math.min(g.length, previous.x));
      const dt = dx / Math.max(1, (previous.velocity + state.velocity) / 2);
      if (!frozen && expansion === 'finite') {
        // A finite throat-curvature length regularizes the conical cusp at M=1.
        // Its scale follows the throat radius and divergence angle, not a fixed
        // chamber-pressure trigger or a user-facing recombination multiplier.
        const expansionLength = Math.max(dx / .22, CONFIG.throatCurvatureFactor * g.throatRadius / Math.tan(g.halfAngle * Math.PI / 180));
        const timescale = expansionLength / Math.max(1, (previous.velocity + state.velocity) / 2);
        const ratioNow = Math.sqrt(Math.max(1e-24, previous.reactionTime * state.reactionTime)) / Math.max(1e-12, timescale);
        if (ratioNow >= 1) {
          const fraction = previousRatio !== null && previousRatio < 1 ? Math.max(0, Math.min(1, -Math.log(previousRatio) / (Math.log(ratioNow) - Math.log(previousRatio)))) : 0;
          freezeAt(previous.pressure * Math.exp(-.22 * fraction)); state = evaluate(p);
        }
        previousRatio = ratioNow;
      }
      if (state.area >= g.exitArea || i === 90) {
        let low = p, high = previous.pressure;
        for (let j = 0; j < 19; j++) { const mid = Math.sqrt(low * high); if (evaluate(mid).area > g.exitArea) low = mid; else high = mid; }
        exit = evaluate(Math.sqrt(low * high));
        residenceTime += Math.max(0, g.length - Math.min(g.length, previous.x)) / Math.max(1, (previous.velocity + exit.velocity) / 2); break;
      }
      residenceTime += dt; previous = state;
    }
    if (!exit) exit = previous;
    const blocked = critical.area >= g.exitArea || !Number.isFinite(exit.velocity);
    const axialVelocity = exit.velocity * g.divergenceEfficiency;
    const pressureThrust = flow > .001 && !blocked ? exit.pressure * g.exitArea / 1000 : 0;
    return { exit, criticalArea: critical.area, freezePressure, residenceTime, blocked,
      jetVelocity: exit.velocity, axialVelocity: blocked ? 0 : axialVelocity,
      pressureThrust, velocity: blocked || !(flow > .001) ? 0 : axialVelocity + pressureThrust * 1000 / flow };
  }
  const api = { CONFIG, DEFAULTS, LIMITS, valid, geometry, chamberPressure, solve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_NOZZLE = api;
})(typeof window !== 'undefined' ? window : globalThis);
