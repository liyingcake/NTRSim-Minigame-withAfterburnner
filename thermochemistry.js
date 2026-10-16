/* Runtime interpolation only. Equilibrium and frozen nozzle expansion are
   precomputed by Cantera; no chemistry solver runs in the browser. */
(function (root) {
  'use strict';
  const table = typeof module !== 'undefined' && module.exports ? require('./thermo-table.js') : root.NTR_THERMO_TABLE;
  const M = table.metadata, data = table.getData(), stride = M.fields.length;
  const nt = M.temperatures.length, nr = M.ratios.length, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function bracket(axis, value) {
    let low = 0, high = axis.length - 1;
    while (high - low > 1) { const mid = (low + high) >> 1; if (axis[mid] > value) high = mid; else low = mid; }
    return [low, high];
  }
  function slice(pressure, ratio) {
    const p = clamp(pressure, M.pressures[0], M.pressures.at(-1)), r = clamp(ratio, 0, M.ratios.at(-1));
    const [pl, ph] = bracket(M.pressures, p), [rl, rh] = bracket(M.ratios, r);
    const wp = Math.log(p / M.pressures[pl]) / Math.log(M.pressures[ph] / M.pressures[pl]);
    // Interpolate elemental mass fraction, so interpolation conserves H and O.
    const z = x => x / (1 + x), wr = (z(r) - z(M.ratios[rl])) / (z(M.ratios[rh]) - z(M.ratios[rl]));
    const offsets = [(pl * nr + rl) * nt * stride, (pl * nr + rh) * nt * stride, (ph * nr + rl) * nt * stride, (ph * nr + rh) * nt * stride];
    const weights = [(1 - wp) * (1 - wr), (1 - wp) * wr, wp * (1 - wr), wp * wr];
    return { p, r, outside: p !== pressure || r !== ratio, read: (t, field) => {
      let value = 0; for (let i = 0; i < 4; i++) value += weights[i] * data[offsets[i] + t * stride + field]; return value;
    } };
  }
  function interpolate(s, temperature, low, high) {
    const loT = M.temperatures[low], hiT = M.temperatures[high], fraction = clamp((temperature - loT) / (hiT - loT), 0, 1);
    const fields = new Array(stride);
    for (let f = 0; f < stride; f++) fields[f] = s.read(low, f) * (1 - fraction) + s.read(high, f) * fraction;
    const y = fields.slice(9, 17), sum = y.reduce((a, b) => a + b, 0);
    let inverseMolar = 0; for (let i = 0; i < y.length; i++) { y[i] = Math.max(0, y[i] / sum); inverseMolar += y[i] / M.molecularWeights[i]; }
    const cp = fields[1], molarMass = 1 / inverseMolar, gamma = cp / (cp - 8314.462618 / molarMass);
    const state = { temperature, h: fields[0], cp, gamma, molarMass, formation: fields[4], exitDrop: fields[5],
      exitTemperature: fields[6], injectionDrop: fields[7], injectionTemperature: fields[8],
      equilibriumExitDrop: fields[17], equilibriumExitTemperature: fields[18], y,
      outside: s.outside || temperature < M.temperatures[0] || temperature > M.temperatures.at(-1) };
    const boundary = clamp(temperature, loT, hiT), delta = temperature - boundary;
    if (delta) {
      // Marked frozen-composition boundary continuation, never a hidden T cap.
      state.h += cp * delta;
      const exponent = (gamma - 1) / gamma;
      state.exitDrop = Math.max(0, state.exitDrop + cp * delta * (1 - Math.min(1, M.exitPressure / s.p) ** exponent));
      state.injectionDrop = Math.max(0, state.injectionDrop + cp * delta * (1 - M.injectionPressureRatio ** exponent));
      state.exitTemperature = Math.max(1, state.exitTemperature + delta * Math.min(1, M.exitPressure / s.p) ** exponent);
      state.equilibriumExitDrop = Math.max(0, state.equilibriumExitDrop + cp * delta * (1 - Math.min(1, M.exitPressure / s.p) ** exponent));
      state.equilibriumExitTemperature = Math.max(1, state.equilibriumExitTemperature + delta * Math.min(1, M.exitPressure / s.p) ** exponent);
    }
    return state;
  }
  function atTemperature(temperature, pressure, ratio = 0) {
    const s = slice(pressure, ratio), [low, high] = bracket(M.temperatures, temperature);
    return interpolate(s, temperature, low, high);
  }
  function fromEnthalpy(enthalpy, pressure, ratio = 0) {
    const s = slice(pressure, ratio);
    let low = 0, high = nt - 1;
    while (high - low > 1) { const mid = (low + high) >> 1; if (s.read(mid, 0) > enthalpy) high = mid; else low = mid; }
    const loH = s.read(low, 0), hiH = s.read(high, 0), fraction = clamp((enthalpy - loH) / (hiH - loH), 0, 1);
    let temperature = M.temperatures[low] + fraction * (M.temperatures[high] - M.temperatures[low]);
    if (enthalpy < loH) temperature += (enthalpy - loH) / s.read(low, 1);
    if (enthalpy > hiH) temperature += (enthalpy - hiH) / s.read(high, 1);
    return interpolate(s, temperature, low, high);
  }
  function wallTransfer(state, flow, wallTemperature, scale, ratedFlow) {
    const difference = Math.max(0, state.temperature - wallTemperature);
    if (!(flow > 0) || !difference) return 0;
    const conductance = 6000 * scale * (flow / Math.max(.01, ratedFlow)) ** .35;
    const limit = flow * state.cp * difference * .08;
    return limit * Math.tanh(conductance * difference / limit);
  }
  function frozenProperties(temperature, y) {
    const t = clamp(temperature, 200, 6000);
    let h = 0, cp = 0, inverseMolar = 0, formation = 0;
    for (let i = 0; i < y.length; i++) {
      if (!y[i]) continue;
      const nasa = M.speciesThermo[i], a = nasa.slice(t > nasa[0] ? 1 : 8, t > nasa[0] ? 8 : 15), r = 8314.462618 / M.molecularWeights[i];
      const speciesCp = r * (a[0] + t * (a[1] + t * (a[2] + t * (a[3] + t * a[4]))));
      const speciesH = r * (t * (a[0] + t * (a[1] / 2 + t * (a[2] / 3 + t * (a[3] / 4 + t * a[4] / 5)))) + a[5]);
      cp += y[i] * speciesCp; h += y[i] * (speciesH + speciesCp * (temperature - t));
      inverseMolar += y[i] / M.molecularWeights[i]; formation += y[i] * M.formationEnthalpies[i];
    }
    const molarMass = 1 / inverseMolar;
    return { temperature, h, cp, molarMass, gamma: cp / (cp - 8314.462618 / molarMass), formation, y, outside: temperature < 200 || temperature > 6000 };
  }
  function frozenFromEnthalpy(h, y) {
    let low = 1, high = 10000;
    for (let i = 0; i < 26; i++) { const mid = (low + high) / 2; if (frozenProperties(mid, y).h > h) high = mid; else low = mid; }
    return frozenProperties((low + high) / 2, y);
  }
  function exhaust(mainFlow, oxygenFlow, gasTemperature, pressureMPa = 4, wallTemperature = 650, scale = 1, propellant = 'hydrogen', expansion = 'equilibrium', regenerativeMW = 0) {
    const flow = mainFlow + oxygenFlow, water = propellant === 'water';
    const ratio = water ? M.waterRatio : mainFlow > 0 ? oxygenFlow / mainFlow : 0;
    const pressure = Math.max(1e3, pressureMPa * 1e6), base = atTemperature(gasTemperature, pressure, water ? M.waterRatio : 0);
    // Wall coolant returns energy to the main stream. This is internal heat
    // recovery, counted once in gas input and subtracted from external cooling.
    const regenerativePower = Math.min(Math.max(0, regenerativeMW), mainFlow * base.cp * M.model[water ? 'waterRegenerativeRise' : 'hydrogenRegenerativeRise'] / 1e6);
    const primary = regenerativePower > 0 && mainFlow > 0 ? fromEnthalpy(base.h + regenerativePower * 1e6 / mainFlow, pressure, water ? M.waterRatio : 0) : base;
    const input = mainFlow * primary.h + oxygenFlow * M.feedEnthalpy.oxygen;
    const preDrop = pressure * M.injectionPressureRatio >= M.exitPressure ? primary.injectionDrop : primary.exitDrop;
    const efficiency = M.model.kineticEfficiency;
    const retainedKinetic = flow > 0 ? efficiency * preDrop * (mainFlow / flow) ** 2 : 0;
    const mixPressure = Math.max(Math.min(M.exitPressure, pressure), pressure * M.injectionPressureRatio);
    // Use the same downstream station at zero oxygen: no discontinuous jump in
    // temperature, composition or velocity when the injection valve closes.
    const mixed = flow > 0 ? fromEnthalpy(input / flow - retainedKinetic, mixPressure, ratio) : primary;
    const heat = wallTransfer(mixed, flow, wallTemperature, scale, (water ? 45 : M.model.hydrogenRatedFlow) * scale);
    const final = flow > 0 && heat > 0 ? fromEnthalpy(mixed.h - heat / flow, mixPressure, ratio) : mixed;
    const drop = expansion === 'frozen' ? final.exitDrop : final.equilibriumExitDrop;
    const kinetic = Math.max(0, retainedKinetic + efficiency * drop), jetVelocity = flow > .001 ? Math.sqrt(2 * kinetic) : 0;
    const exitEnthalpy = final.h - efficiency * drop;
    const exit = expansion === 'frozen' ? frozenFromEnthalpy(exitEnthalpy, final.y) : fromEnthalpy(exitEnthalpy, Math.min(pressure, M.exitPressure), ratio);
    // Vacuum pressure thrust. The fixed-Pe approximation implies an equivalent
    // exit area from continuity; it does not solve a fixed nozzle geometry.
    const gasConstant = 8314.462618 / exit.molarMass, soundSpeed = Math.sqrt(Math.max(1, exit.gamma * gasConstant * exit.temperature));
    const mach = jetVelocity / soundSpeed, u = clamp(mach - 1, 0, 1), chokedWeight = u * u * (3 - 2 * u);
    const pressureVelocity = jetVelocity > 0 ? chokedWeight * gasConstant * Math.max(1, exit.temperature) / jetVelocity : 0;
    const pressureThrust = flow * pressureVelocity / 1000, velocity = jetVelocity + pressureVelocity;
    const masses = exit.y.map(fraction => fraction * flow);
    const chemicalPower = oxygenFlow > 0 ? Math.max(0, -exit.formation * flow / 1e6) : 0;
    const waterFraction = Math.min(1, ratio / M.waterRatio) * (1 + M.waterRatio) / (1 + ratio);
    const completeFormation = waterFraction * M.formationEnthalpies[5];
    const reference = completeFormation * flow, exitFormation = exit.formation * flow;
    const feedFormation = water ? mainFlow * M.formationEnthalpies[5] : 0;
    const feedInput = mainFlow * M.feedEnthalpy[water ? 'water' : 'hydrogen'] + oxygenFlow * M.feedEnthalpy.oxygen;
    return { flow, velocity, jetVelocity, pressureThrust, equivalentExitArea: pressureThrust * 1000 / Math.min(pressure, M.exitPressure),
      exitTemperature: exit.temperature, expansion, regenerativePower, primaryTemperature: primary.temperature, temperature: final.temperature, chemicalPower, kineticPower: kinetic * flow / 1e6,
      heatLoad: heat / 1e6, mixtureRatio: water ? 0 : ratio, pressure: mixPressure / 1e6, molarMass: exit.molarMass, gamma: exit.gamma,
      steam: masses[5], hydrogen: masses[0], oxygen: masses[2], atomicHydrogen: masses[1], atomicOxygen: masses[3], hydroxyl: masses[4],
      hydroperoxyl: masses[6], peroxide: masses[7], radicals: masses[1] + masses[3] + masses[4] + masses[6] + masses[7],
      fractions: Object.fromEntries(M.species.map((name, i) => [name, exit.y[i]])),
      mixFractions: Object.fromEntries(M.species.map((name, i) => [name, final.y[i]])),
      primaryFractions: Object.fromEntries(M.species.map((name, i) => [name, primary.y[i]])),
      dissociationPower: Math.max(0, exit.formation - completeFormation) * flow / 1e6,
      mixDissociationPower: Math.max(0, final.formation - completeFormation) * flow / 1e6,
      outside: primary.outside || final.outside || exit.outside,
      energy: { input: input / 1e6, wall: heat / 1e6, kinetic: kinetic * flow / 1e6, exhaust: exitEnthalpy * flow / 1e6,
        available: (input - reference) / 1e6, nuclearTransported: mainFlow * (base.h - M.feedEnthalpy[water ? 'water' : 'hydrogen']) / 1e6, regenerativeReturn: regenerativePower,
        idealChemical: (feedFormation - reference) / 1e6, feedConditioning: (feedFormation - feedInput) / 1e6,
        exhaustThermal: (flow * exitEnthalpy - exitFormation) / 1e6, dissociation: (exitFormation - reference) / 1e6,
        residual: (input - heat - flow * kinetic - flow * exitEnthalpy) / 1e6 } };
  }
  const api = { metadata: M, atTemperature, fromEnthalpy, wallTransfer, exhaust };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_THERMO = api;
})(typeof window !== 'undefined' ? window : globalThis);
