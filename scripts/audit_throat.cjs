/* Functional nozzle audit: matched controls and matched inlet states.
   No browser, frame-rate sampling or performance profiling. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const nozzle = require('../nozzle.js'), thermo = require('../thermochemistry.js');
const { NTRSimulation } = require('../simulation.js');
const release = require('../version.js');
const SCALES = [.25, .5, .75, 1, 1.5, 2, 4];
const BASE_EXIT = nozzle.geometry(1.4).exitArea;
const cycles = ['hydrogen', 'lantr', 'water'];
const names = { hydrogen: '纯氢核热', lantr: '液氧补燃', water: '水核热' };
function settings(throatScale, fixedExit = false) {
  return { ...nozzle.DEFAULTS, throatScale, expansionRatio: fixedExit ? 240 / throatScale : 240 };
}
function engineRun(cycle, throatScale, fixedExit = false) {
  const e = new NTRSimulation({ random: () => .5 }); e.reset(true);
  e.configure(cycle === 'water' ? 'water' : 'hydrogen', 1.4);
  assert.ok(e.configureNozzle(settings(throatScale, fixedExit)).ok);
  assert.ok(e.setLoadout(cycle === 'water' ? 30000 : 5000, cycle === 'lantr' ? 20000 : 0).ok);
  e.oxygenPump = cycle === 'lantr'; e.oxygenValve = cycle === 'lantr' ? 30 : 0;
  e.start(); let peakPressure = 0, peakCore = 293, maxResidual = 0, trip = null;
  for (let i = 0; i < 1200; i++) {
    const before = e.mode; e.step(.05);
    peakPressure = Math.max(peakPressure, e.pressure); peakCore = Math.max(peakCore, e.coreTemperature);
    maxResidual = Math.max(maxResidual, Math.abs(e.nozzleEnergy.residual), Math.abs(e.nozzleEnergy.cycleResidual));
    if (!trip && e.mode === 'SCRAM' && before !== 'SCRAM') trip = { time: e.time, pressureMPa: e.pressure, coreK: e.coreTemperature, reason: e.events[0].message };
  }
  assert.ok(maxResidual < 1e-6, `Energy closure ${cycle}/${throatScale}: ${maxResidual}`);
  assert.equal(e.pressureFailures, 0); // Keep stochastic damage out of comparisons.
  return { cycle, throatScale, constraint: fixedExit ? 'fixedExitArea' : 'fixedExpansionRatio', geometry: e.nozzle,
    time: e.time, mode: e.mode, pressureMPa: e.pressure, peakPressureMPa: peakPressure, coreK: e.coreTemperature, peakCoreK: peakCore,
    gasK: e.thermoState.primaryTemperature, mixK: e.nozzleTemperature, wallK: e.nozzleWallTemperature,
    mainFlowKgS: e.flow, oxygenFlowKgS: e.oxygenFlow, thrustKN: e.thrust, ispS: e.isp, jetVelocityMS: e.jetVelocity,
    exitPressurePa: e.thermoState.exitPressure, exitK: e.thermoState.exitTemperature, primaryH: e.thermoState.primaryFractions.H,
    exitH: e.thermoState.fractions.H, freezePressurePa: e.thermoState.freezePressure,
    heatMW: e.nozzleHeatLoad, regenerativeMW: e.regenerativePower, kineticMW: e.kineticPower,
    equivalentMixedCriticalArea: e.thermoState.criticalArea, dryMassKg: e.dryMass, massKg: e.mass,
    acceleration: e.acceleration, deltaV: e.flight.deltaV, maxEnergyResidualMW: maxResidual, trip };
}
function fixedState(cycle, throatScale, fixedExit = false) {
  const water = cycle === 'water', g = nozzle.geometry(1.4, settings(throatScale, fixedExit));
  const flow = water ? 31.5 : 10.36, oxygen = cycle === 'lantr' ? 22.2 : 0, gasK = water ? 3000 : 2500;
  let pressure = 4e6;
  for (let i = 0; i < 20; i++) pressure = nozzle.chamberPressure(flow, thermo.atTemperature(gasK, pressure, water ? thermo.metadata.waterRatio : 0), g);
  const s = thermo.exhaust(flow, oxygen, gasK, pressure / 1e6, 650, 1, water ? 'water' : 'hydrogen', 'finite', 0, g);
  assert.ok(Math.abs(s.energy.residual) < 1e-6);
  return { cycle, throatScale, geometry: g, gasK, mainFlowKgS: flow, oxygenFlowKgS: oxygen, pressureMPa: pressure / 1e6,
    thrustKN: s.flow * s.velocity / 1000, ispS: s.velocity / 9.80665, heatMW: s.heatLoad,
    exitPressurePa: s.exitPressure, exitH: s.fractions.H, blocked: s.blocked, energyResidualMW: s.energy.residual };
}
const fixedRatio = cycles.flatMap(c => SCALES.map(k => engineRun(c, k)));
// 0.25 would require epsilon=960, outside the actual UI limit of 500.
const fixedExit = cycles.flatMap(c => SCALES.filter(k => k >= .5).map(k => engineRun(c, k, true)));
const matchedStates = cycles.flatMap(c => SCALES.map(k => fixedState(c, k)));
const report = { version: release.version, pressureWarnings: require('../reliability.js').PRESSURE,
  controls: { diameter: 1.4, demand: 60, mainValve: 70, halfAngle: 12, extension: 0,
    baseExpansion: 240, fixedExitArea: BASE_EXIT, elapsedSeconds: 60, coldStart: true, autoProtection: true,
    payload: 0, loadouts: { hydrogen: { mainKg: 5000, oxygenKg: 0, oxygenValve: 0 },
      lantr: { mainKg: 5000, oxygenKg: 20000, oxygenValve: 30 }, water: { mainKg: 30000, oxygenKg: 0, oxygenValve: 0 } } },
  method: 'Only throatScale changes in fixedRatio runs; fixedExit runs additionally adjust expansionRatio=240/throatScale to preserve physical exit area. All controls, initial temperature and sampling time match within each cycle. Geometry, wall response and mass respond naturally. MatchedStates separately fixes gas T/flow/wall T, derives chamber pressure, and does not represent a sustained protected engine run. Pump flow is commanded; a pump back-pressure characteristic is not solved. Trip rows must not be treated as steady performance.',
  fixedRatio, fixedExit, matchedStates };
fs.writeFileSync(`benchmarks/${release.label}-throat-audit.json`, JSON.stringify(report, null, 2) + '\n');
const f = (v, p = 2) => v.toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p });
const table = (head, rows) => `| ${head.join(' | ')} |\n| ${head.map(() => '---:').join(' | ')} |\n` + rows.map(r => '| ' + r.join(' | ') + ' |').join('\n') + '\n';
const geometryTable = data => table(['喉部倍率', 'At / m²', '喉径 Dt / mm', 'Ae / m²', '出口直径 / m', '几何膨胀比 Ae/At', '长度 / m', '喷管质量 / kg'], data.map(s => {
  const g = s.geometry; return [f(s.throatScale), f(g.throatArea, 5), f(g.throatRadius * 2000), f(g.exitArea, 3), f(g.exitRadius * 2, 3), f(g.expansion, 1), f(g.length, 3), f(g.mass, 1)];
}));
const performanceTable = data => table(['喉部倍率', '腔压 / MPa', '推力 / kN', '比冲 / s', '加速度 / m/s²', '60 s Δv / m/s', '出口压力 / Pa', '状态'], data.map(s => s.trip
  ? [f(s.throatScale), '—', '—', '—', '—', f(s.deltaV), '—', 'SCRAM，见下文']
  : [f(s.throatScale), f(s.pressureMPa, 3), f(s.thrustKN, 3), f(s.ispS), f(s.acceleration, 3), f(s.deltaV), f(s.exitPressurePa, 2), '运行']));
let md = `# ${release.label} 喉部面积核查\n\n压力告警已改为 **13 / 14 / 15 MPa 黄 / 橙 / 红**。15.5 MPa 保护和连续超压每 5 个模拟秒的随机损伤规则保持原值。\n\n## 对照条件\n\nD1.4、60% 核热功率（额定 600 MW）、70% 主阀、12° 半角、无延长段、无货物，从 293 K 冷态开始运行 60 个模拟秒，自动保护开启。纯氢为 5 t 氢；补燃为 5 t 氢 + 20 t 氧、30% 氧阀；水为 30 t 水。泵波动相位与取样时间相同。结果是本游戏模型计算，不是实测发动机性能。\n\n## A：只改当前喉部旋钮，膨胀比固定 240\n\n当前几何定义为 Ae = At × ε。固定 ε 和半角时，改变 At 会同步缩放出口与基础段长度；并非只移动喉部轮廓。\n\n${geometryTable(fixedRatio.filter(s => s.cycle === 'hydrogen'))}\n`;
for (const c of cycles) md += `\n### ${names[c]}\n\n${performanceTable(fixedRatio.filter(s => s.cycle === c))}`;
for (const s of fixedRatio.filter(s => s.trip)) md += `\n${names[s.cycle]}、${s.throatScale} 倍：${f(s.trip.time)} s 触发「${s.trip.reason}」，当时腔压 ${f(s.trip.pressureMPa, 3)} MPa、堆芯 ${f(s.trip.coreK, 1)} K。停堆后的 60 s 零推力不作为正常喷管性能比较。\n`;
md += `\n## B：出口面积固定 ${f(BASE_EXIT, 3)} m²\n\n这组保持实际出口尺寸不变，改变喉部后将几何膨胀比调为 240 / 喉部倍率。它需要同时调整两个控制项，不能与 A 混称“只改一个旋钮”。0.25 倍需 ε=960，超过控制台上限 500，因此只列控制台可设置的 0.5–4 倍。\n\n${geometryTable(fixedExit.filter(s => s.cycle === 'hydrogen'))}\n`;
for (const c of cycles) md += `\n### ${names[c]}\n\n${performanceTable(fixedExit.filter(s => s.cycle === c))}`;
md += `\n## 固定气体入口的附加检查\n\n为区分反应堆和壁温响应，另固定氢入口 2,500 K、10.36 kg/s，补燃加氧 22.2 kg/s；水入口 3,000 K、31.5 kg/s。壁温均为 650 K、不加再生回热，由实际流量和喉部反算腔压。该计算是瞬时边界对照，不表示高压下可以持续运行。\n`;
for (const c of cycles) md += `\n### ${names[c]}\n\n${table(['倍率', 'At / m²', 'Ae/At', '腔压 / MPa', '推力 / kN', '比冲 / s'], matchedStates.filter(s => s.cycle === c).map(s => [f(s.throatScale), f(s.geometry.throatArea, 5), f(s.geometry.expansion, 1), f(s.pressureMPa, 3), f(s.thrustKN, 3), f(s.ispS)]))}`;
md += '\n## 结果解释与适用范围\n\n- 模型的供液泵由阀位直接给定质量流量，未求解泵扬程、背压、转速的完整特性。相同流量与气体状态下，堵塞流关系使腔压近似反比于 At。较小喉部因此主要升压，不能凭空增加反应堆功率或喷出的质量流量。\n- A 的膨胀比始终为 240，基础几何缩放后，理想恒比热喷管本就不会仅因绝对尺寸变化而获得成倍排速。当前小幅差异来自压力相关物性与组分、冻结、壁面换热及回热响应。\n- A 中放大喉部会同时增加出口、长度、表面积和质量；增大的出口不等于更高的几何膨胀比。B 才展示固定出口下、喉部越小膨胀比越大的另一种取舍。\n- 喷管质量直接进入干重；比较任务收益应同时看加速度和 Δv，不能只看比冲。缩小喉部也会压缩耐压余量。\n- 几何膨胀比是实际 Ae/At。JSON 中的 equivalentMixedCriticalArea 是补燃混合流的等效临界截面，不能冒充实体喉部。\n- 守恒检查覆盖整机对照每一步和固定入口工况；本轮未采集浏览器帧率，未进行性能优化或浏览器交互验收。\n\n完整未舍入数据：`benchmarks/' + release.label + '-throat-audit.json`。复现：`node scripts/audit_throat.cjs`。\n';
fs.writeFileSync(`THROAT-${release.label.toUpperCase()}.md`, md);
console.table(fixedRatio.map(s => ({ cycle: s.cycle, throat: s.throatScale, At: f(s.geometry.throatArea, 5), expansion: s.geometry.expansion, pressure: f(s.pressureMPa, 3), thrust: f(s.thrustKN, 3), isp: f(s.ispS), mode: s.mode })));
console.table(fixedExit.filter(s => s.cycle === 'lantr').map(s => ({ throat: s.throatScale, expansion: s.geometry.expansion, mass: f(s.geometry.mass, 1), pressure: f(s.pressureMPa, 3), thrust: f(s.thrustKN, 3), isp: f(s.ispS) })));
