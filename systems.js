/* Shared game constants and simplified LANTR mass / energy accounting.
   Densities are fixed storage values, not an equation of state. */
(function (root) {
  'use strict';
  const TANK = Object.freeze({ volume: 150, divider: 10, hydrogen: 70.8, oxygen: 1138, water: 1000 });
  const PRICES = Object.freeze({ hydrogen: 10, oxygen: 3, water: 2 });
  const OXIDIZER_RATIO = 8; // Approximate O2:H2 stoichiometric mass ratio.
  function loadout(propellant, fuel, oxygen = 0, installed = oxygen > 0) {
    const known = ['hydrogen', 'water'].includes(propellant);
    const fuelVolume = known ? fuel / TANK[propellant] : Infinity;
    const oxygenVolume = oxygen / TANK.oxygen, dividerVolume = installed ? TANK.divider : 0;
    const usedVolume = fuelVolume + oxygenVolume + dividerVolume;
    const valid = known && [fuel, oxygen].every(Number.isFinite) && fuel >= 10 && oxygen >= 0
      && !(propellant === 'water' && (oxygen > 0 || installed)) && usedVolume <= TANK.volume + 1e-9;
    const message = !known || !Number.isFinite(fuel) || !Number.isFinite(oxygen) || fuel < 10 || oxygen < 0 ? '请输入有效加注量，主推进剂至少 10 kg'
      : propellant === 'water' && (oxygen > 0 || installed) ? '液氧补燃需要液氢；水模式不安装液氧舱'
      : usedVolume > TANK.volume + 1e-9 ? '超出 150 m³ 容积；双推进剂需额外预留 10 m³ 隔断' : '';
    return { valid, message, fuelVolume, oxygenVolume, dividerVolume, usedVolume, freeVolume: TANK.volume - usedVolume,
      maxFuel: known ? Math.max(0, Math.floor((TANK.volume - oxygenVolume - dividerVolume) * TANK[propellant] + 1e-8)) : 0,
      maxOxygen: propellant === 'hydrogen' ? Math.max(0, Math.floor((TANK.volume - TANK.divider - fuelVolume) * TANK.oxygen + 1e-8)) : 0 };
  }
  // Bounded, repeatable quasi-periodic pump variation: ±3.25% of commanded flow.
  function pumpRipple(command, time, phase = 0) {
    return command * .0325 * (.62 * Math.sin(time * 7.1 + phase) + .26 * Math.sin(time * 17.3 + phase * 1.7) + .12 * Math.sin(time * 31.7 + phase * .6));
  }
  function mixExhaust(hydrogen, oxygen, baseVelocity, gasTemperature) {
    const reactedHydrogen = Math.min(hydrogen, oxygen / OXIDIZER_RATIO);
    const steam = reactedHydrogen * 9, unburnedHydrogen = Math.max(0, hydrogen - reactedHydrogen);
    const unburnedOxygen = Math.max(0, oxygen - reactedHydrogen * OXIDIZER_RATIO);
    const flow = hydrogen + oxygen;
    const chemicalPower = reactedHydrogen * 120; // MW; ~120 MJ/kg H2, water vapor products.
    const kineticPower = .5 * hydrogen * baseVelocity ** 2 / 1e6 + chemicalPower * .85;
    const velocity = flow > 0 ? Math.sqrt(Math.max(0, 2 * kineticPower * 1e6 / flow)) : 0;
    const heatCapacity = unburnedHydrogen * 14000 + steam * 2700 + unburnedOxygen * 1100;
    const temperature = heatCapacity > 0 ? Math.min(4800, Math.max(gasTemperature,
      (hydrogen * 14000 * gasTemperature + oxygen * 1100 * 90 + chemicalPower * 1e6) / heatCapacity)) : gasTemperature;
    return { flow, chemicalPower, kineticPower, velocity, temperature, steam, hydrogen: unburnedHydrogen, oxygen: unburnedOxygen,
      mixtureRatio: hydrogen > 0 ? oxygen / hydrogen : 0 };
  }
  const api = { TANK, PRICES, OXIDIZER_RATIO, loadout, pumpRipple, mixExhaust };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NTR_SYSTEMS = api;
})(typeof window !== 'undefined' ? window : globalThis);
