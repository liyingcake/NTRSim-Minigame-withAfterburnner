// Reproducible CPU-only benchmark. Browser frame pacing is measured separately.
const { performance } = require('node:perf_hooks');
const { NTRSimulation } = require('../simulation.js');
const { NTRChallenge, formatPoints } = require('../challenge.js');
const { summarize } = require('../performance.js');
const results = [];
for (const speed of [1, 25]) {
  const costs = [];
  for (let repetition = 0; repetition < 20; repetition++) {
    const engine = new NTRSimulation();
    const mission = new NTRChallenge(engine, { type: 'lunar', fuelLoad: 5000, oxygenLoad: 50000, payload: 50000 });
    Object.assign(engine, { pump: true, cooling: true, demand: 60, valve: 70, oxygenPump: true, oxygenValve: 60 });
    mission.startEngine(); for (let i = 0; i < 20; i++) mission.tick(1);
    const start = performance.now();
    for (let frame = 0; frame < 500; frame++) mission.tick(speed / 60);
    costs.push((performance.now() - start) / 500);
  }
  results.push({ name: 'LANTR physics', speed, msPer60HzFrame: summarize(costs) });
}
let checksum = 0;
const start = performance.now();
for (let i = 0; i < 10000; i++) checksum += formatPoints(12345.678 + i, 2).length;
results.push({ name: 'number format', calls: 10000, totalMs: performance.now() - start, checksum });
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
