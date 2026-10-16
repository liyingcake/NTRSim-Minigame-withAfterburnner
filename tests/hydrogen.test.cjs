const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../thermochemistry.js');
const audit = require('../benchmarks/v0.9-hydrogen-audit.json');
test('neutral atomic hydrogen at 3000 K and 0.5 MPa agrees with the independent Cantera reference', () => {
  const reference = audit.reference.find(r => r.gasTemperature === 3000 && r.pressurePa === 500000);
  const state = t.atTemperature(3000, 500000);
  assert.ok(Math.abs(state.y[1] - reference.hMassFraction) < 1e-8);
  assert.ok(state.y[1] > .03 && state.y[1] < .04); assert.ok(!t.metadata.species.includes('H+'));
  const output = t.exhaust(10, 0, 3000, .5);
  assert.equal(output.primaryFractions.H, state.y[1]); assert.ok(output.fractions.H < output.primaryFractions.H);
  assert.ok(Math.abs(output.energy.residual) < 1e-8);
});
test('pressure influences dissociation smoothly, and fixed enthalpy cannot buy free thermal energy', () => {
  const high = t.atTemperature(3000, 1e6), low = t.atTemperature(3000, 1e5);
  assert.ok(low.y[1] > high.y[1]); assert.ok(low.h > high.h);
  const left = t.atTemperature(3000, 500001), right = t.atTemperature(3000, 499999);
  assert.ok(Math.abs(left.y[1] - right.y[1]) < 1e-6);
  const conserved = t.fromEnthalpy(high.h, 1e5);
  assert.ok(conserved.temperature < high.temperature); assert.ok(Math.abs(conserved.h - high.h) < 1e-6);
});
