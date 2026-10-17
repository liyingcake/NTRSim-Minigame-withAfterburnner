/* Reproducible concept sizing, not the DLC flight model. Run with --write
   to refresh benchmarks/water-dlc-design.json. All masses include hardware;
   water converted to gas is transferred inventory, never extra wet mass. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const config = require('../water-dlc-design.json');
const { metadata } = require('../thermochemistry.js');
const a = config.assumptions, c = config.costs;
const ratio = metadata.waterRatio;
const hydrogenFraction = 1 / (1 + ratio), oxygenFraction = ratio / (1 + ratio);
const electricIsp = hydrogenFraction * a.hydrogenIspS + oxygenFraction * a.oxygenIspS;
const electricVe = electricIsp * a.g0;
const electricKWhPerKg = isp => (isp * a.g0) ** 2 / (2 * a.electricEfficiencyBusToJet * 3.6e6);
const oxygenKWhPerKg = electricKWhPerKg(a.oxygenIspS);
const hydrogenKWhPerKg = electricKWhPerKg(a.hydrogenIspS);
const cycleKWhPerKg = a.electrolysisKWhPerKgWater + hydrogenFraction * hydrogenKWhPerKg + oxygenFraction * oxygenKWhPerKg;
const balancedShares = {
  electrolysis: a.electrolysisKWhPerKgWater / cycleKWhPerKg,
  hydrogenElectric: hydrogenFraction * hydrogenKWhPerKg / cycleKWhPerKg,
  oxygenElectric: oxygenFraction * oxygenKWhPerKg / cycleKWhPerKg
};
assert.ok(Math.abs(Object.values(balancedShares).reduce((s, n) => s + n, 0) - 1) < 1e-12);
assert.ok(Math.abs(hydrogenKWhPerKg / oxygenKWhPerKg - 9) < 1e-12);
assert.ok(Math.abs(hydrogenFraction + oxygenFraction - 1) < 1e-12);

function size(model) {
  const grossPower = model.powerSource === 'solar20' ? a.solarPowerKWAt1AU : a.nuclearElectricPowerKW;
  const usablePower = grossPower - model.hotelPowerKW;
  const elPower = Math.min(model.electrolyzerKW, usablePower);
  const epPower = Math.min(model.electricRatedKW, usablePower);
  // A common gas-production sequence stops when either buffer reaches capacity.
  const bufferWater = Math.min(model.hydrogenCapacityKg / hydrogenFraction, model.oxygenCapacityKg / oxygenFraction);
  assert.ok(bufferWater <= model.waterKg);
  const h = bufferWater * hydrogenFraction, o = bufferWater * oxygenFraction;
  const hardware = {
    power: model.powerPackageKg,
    waterTank: a.waterTankBaseKg + model.waterKg / a.waterKgPerKgVariableTank,
    gasTanks: model.hydrogenCapacityKg / a.hydrogenKgPerKgTank + model.oxygenCapacityKg / a.oxygenKgPerKgTank,
    battery: model.batteryKWh / a.batteryKWhPerKg,
    electrolyzer: 2 + 2 * model.electrolyzerKW,
    electricPropulsion: model.electricPackageKg,
    chemicalEngines: a.chemicalEngineMassKg * model.chemicalEngineCount,
    feedAndThermal: model.feedThermalKg
  };
  hardware.busAndMission = model.dryMassKg - Object.values(hardware).reduce((s, n) => s + n, 0);
  assert.ok(hardware.busAndMission > 0);
  assert.ok(Math.abs(Object.values(hardware).reduce((s, n) => s + n, 0) - model.dryMassKg) < 1e-9);
  assert.ok(model.batteryKWh <= 10);
  const wetMass = model.dryMassKg + model.payloadKg + model.waterKg;
  const thrust = model.chemicalEngineCount * a.chemicalEngineThrustN;
  const burn = (mixture, isp) => {
    const consumedH = Math.min(h, o / mixture), consumedO = consumedH * mixture;
    const propellant = consumedH + consumedO, ve = isp * a.g0;
    return {
      mixtureRatio: mixture, ispS: isp, consumedKg: propellant,
      hydrogenRemainingKg: h - consumedH, oxygenRemainingKg: o - consumedO,
      burnSeconds: propellant * ve / thrust,
      deltaVMPerS: ve * Math.log(wetMass / (wetMass - propellant))
    };
  };
  const balancedBurn = burn(ratio, a.chemicalBalancedIspS);
  const bestIspBurn = burn(a.chemicalBestMixtureRatio, a.chemicalBestIspS);
  assert.ok(Math.abs(balancedBurn.consumedKg - bufferWater) < 1e-9);
  const waterPerDay = usablePower * 24 / cycleKWhPerKg;
  const busMassCost = hardware.busAndMission * c.busKCrPerKg;
  const costs = {
    power: model.powerSource === 'solar20' ? c.solar20PackageKCr : c.nuclear100PackageKCr,
    electricPropulsion: model.electricPackageKCr,
    electrolyzer: c.electrolyzerBaseKCr + c.electrolyzerKCrPerKW * model.electrolyzerKW,
    chemicalEngines: c.chemicalEngineKCr * model.chemicalEngineCount,
    gasTanks: model.hydrogenCapacityKg * c.hydrogenTankKCrPerKgCapacity + model.oxygenCapacityKg * c.oxygenTankKCrPerKgCapacity,
    waterTank: c.waterTankBaseKCr + c.waterTankKCrPerKgCapacity * model.waterKg,
    battery: c.batteryKCrPerKWh * model.batteryKWh,
    feedAndThermal: c.feedThermalKCrPerKg * model.feedThermalKg,
    busAndMission: busMassCost + model.missionHardwareExtraKCr
  };
  return {
    id: model.id, name: model.name, dryMassKg: model.dryMassKg, payloadKg: model.payloadKg,
    initialWetMassKg: wetMass, hardwareMassKg: hardware, hardwareCostKCr: costs,
    totalHardwareCostKCr: Object.values(costs).reduce((s, n) => s + n, 0), waterLoadingCostKCr: model.waterKg * c.waterKCrPerKg,
    usablePowerKW: usablePower, batteryPeakPowerKW: model.batteryKWh * a.batteryDischargeC,
    batteryBusOnlyHours: model.batteryKWh * a.batteryUsableFraction / model.hotelPowerKW,
    preparedBufferKg: { hydrogen: h, oxygen: o, total: bufferWater },
    initialWaterAfterBufferPreparationKg: model.waterKg - bufferWater,
    chargeOnlyPowerKW: elPower, chargeOnlyWaterKgPerHour: elPower / a.electrolysisKWhPerKgWater,
    fullBufferChargeHours: bufferWater * a.electrolysisKWhPerKgWater / elPower,
    chemicalThrustN: thrust, chemicalInitialAccelerationMPerS2: thrust / wetMass,
    balancedChemicalBurn: balancedBurn, bestIspChemicalBurn: bestIspBurn,
    oxygenOnlyElectricThrustN: 2 * a.electricEfficiencyBusToJet * epPower * 1000 / (a.oxygenIspS * a.g0),
    hydrogenOnlyElectricThrustN: 2 * a.electricEfficiencyBusToJet * epPower * 1000 / (a.hydrogenIspS * a.g0),
    balancedElectricAverageThrustN: waterPerDay / 86400 * electricVe,
    balancedElectricWaterKgPerDay: waterPerDay,
    balancedElectricInitialDeltaVMPerSDay: electricVe * Math.log(wetMass / (wetMass - waterPerDay)),
    idealElectricWaterExhaustionDays: model.waterKg / waterPerDay,
    idealAllWaterElectricDeltaVMPerS: electricVe * Math.log(wetMass / (model.dryMassKg + model.payloadKg)),
    balancedElectricPowerKW: Object.fromEntries(Object.entries(balancedShares).map(([key, share]) => [key, share * usablePower]))
  };
}
const sigma = 5.670374419e-8;
const highHeat = a.nuclearElectricPowerKW * (1 / a.nuclearConversionEfficiency - 1);
const result = {
  status: config.status,
  caveats: 'Optimistic game design, ideal continuous power and no wear/leaks/reserve; not an implemented flight model. Gas preparation transfers water inventory. Costs are fictional. Solar figures assume 1 AU, continuous illumination.',
  constants: {
    waterOxygenHydrogenMassRatio: ratio, hydrogenFraction, oxygenFraction,
    balancedElectricEffectiveIspS: electricIsp, oxygenKWhPerKg, hydrogenKWhPerKg,
    balancedElectricCycleKWhPerKgWater: cycleKWhPerKg, balancedPowerShares: balancedShares,
    nuclearRejectedHeatKW: highHeat,
    nuclearIdealHighTemperatureRadiatingAreaM2: highHeat * 1000 / (a.radiatorEmissivity * sigma * a.highTemperatureRadiatorK ** 4)
  },
  models: config.models.map(size)
};
for (const m of result.models) {
  assert.ok(m.balancedElectricPowerKW.electrolysis <= config.models.find(x => x.id === m.id).electrolyzerKW);
  assert.ok(Math.abs(Object.values(m.balancedElectricPowerKW).reduce((s, n) => s + n, 0) - m.usablePowerKW) < 1e-9);
}
if (process.argv.includes('--write')) fs.writeFileSync(path.join(__dirname, '..', 'benchmarks', 'water-dlc-design.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
