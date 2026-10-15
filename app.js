'use strict';
const sim = new NTRSimulation();
const $ = id => document.getElementById(id);
const canvas = $('mfdCanvas');
const ctx = canvas.getContext('2d');
const mono = '"IBM Plex Mono", Consolas, "Microsoft YaHei", monospace';
const C = { green: '#a2c493', bright: '#c1dca4', dim: '#55714e', faint: '#2e4835', amber: '#d3b372', blue: '#8abcc1', red: '#db8e70', bg: '#111d18' };
let page = 'overview', paused = false, speed = 1, lampTest = false, lastLogId = -1;
let lastFrame = performance.now(), lastRender = 0, toastTimeout, lampTimeout;
let motionTime = 0;
let mission = null, resultShown = false;
let selectedChallenge = 'endurance', selectedPropellant = 'hydrogen';
const selectedFuelLoads = { ...NTR_DEFAULT_LOADS };
let scoreStorage;
try { scoreStorage = window.localStorage; } catch { /* Private/file contexts may disallow browser storage. */ }
const leaderboard = new NTRLeaderboard(scoreStorage);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MODE = { RUNNING: '稳定运行', STARTING: '启动序列', SHUTDOWN: '停机冷却', STANDBY: '系统待机', SCRAM: '紧急停堆', DAMAGED: '堆芯损坏' };
const pageNames = { overview: 'SYS / 系统总览', thermal: 'THM / 热力回路', propulsion: 'PRP / 推进性能', trend: 'TEL / 遥测趋势', diagnostics: 'DGN / 故障诊断' };
const num = (v, places = 0) => Number.isFinite(v) ? v.toFixed(places) : '—';
const points = NTR_FORMAT_POINTS;
const clock = t => [Math.floor(t / 3600), Math.floor(t / 60) % 60, Math.floor(t) % 60].map(n => String(n).padStart(2, '0')).join(':');
const safe = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(message) {
  $('toast').textContent = message; $('toast').classList.add('visible');
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => $('toast').classList.remove('visible'), 3600);
}

function gaugeMarkup(max, major, label, danger) {
  const point = (v, r) => { const a = (150 + 240 * v / max) * Math.PI / 180; return [120 + Math.cos(a) * r, 110 + Math.sin(a) * r]; };
  const arc = (from, to, r) => { const a = point(from, r), b = point(to, r); return `M ${a[0]} ${a[1]} A ${r} ${r} 0 ${to - from > max * .75 ? 1 : 0} 1 ${b[0]} ${b[1]}`; };
  let ticks = '';
  for (let i = 0; i <= major * 5; i++) {
    const v = max * i / (major * 5), isMajor = i % 5 === 0;
    const a = point(v, 88), b = point(v, isMajor ? 77 : 82);
    ticks += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${v >= danger ? '#c58c70' : '#b3b797'}" stroke-width="${isMajor ? 1.5 : .7}"/>`;
    if (isMajor) { const p = point(v, 66); ticks += `<text x="${p[0]}" y="${p[1] + 3}" text-anchor="middle" fill="#c6c6a3" font-size="10" font-family="${mono.replaceAll('"', '')}">${num(v, max < 5 && v % 1 !== 0 ? 1 : 0)}</text>`; }
  }
  return `<path d="${arc(0, max, 96)}" stroke="#56634c" fill="none" stroke-width="1"/><path d="${arc(danger, max, 92)}" stroke="#b27b5d" fill="none" stroke-width="3" opacity=".7"/>${ticks}<text x="120" y="67" text-anchor="middle" fill="#7e8d70" font-size="8" font-family="Consolas">${label}</text><g class="needle" style="transform-origin:120px 110px"><path d="M 117 119 L 120 29 L 123 119 Z" fill="#dac897"/><circle cx="120" cy="110" r="8" fill="#68725a" stroke="#20291f" stroke-width="3"/><circle cx="120" cy="110" r="3" fill="#b5b99a"/></g><rect x="87" y="132" width="66" height="20" rx="1" fill="#182319" stroke="#4c5c40"/><text class="gauge-reading" x="120" y="146" text-anchor="middle" fill="#c3cf9f" font-size="12" font-family="Consolas">0.00</text>`;
}
$('temperatureGauge').innerHTML = gaugeMarkup(4, 4, 'CORE / K', 3.2);
$('pressureGauge').innerHTML = gaugeMarkup(8, 4, 'CHAMBER / MPa', 6.5);
$('tankSegments').innerHTML = '<i></i>'.repeat(20);
$('lampMatrix').innerHTML = sim.lamps.map(([id, label, english, color]) => `<div class="status-lamp ${color}" id="lamp-${id}" aria-label="${label}"><span>${label}</span><small>${english}</small></div>`).join('');

function drawGauge(id, value, maximum, places) {
  const svg = $(id);
  svg.querySelector('.needle').style.transform = `rotate(${-120 + Math.min(1, Math.max(0, value / maximum)) * 240}deg)`;
  svg.querySelector('.gauge-reading').textContent = num(value, places);
}

function updateSliders() {
  $('powerSlider').value = sim.demand; $('valveSlider').value = sim.valve; $('sizeSlider').value = sim.diameter;
  $('powerOutput').innerHTML = `${num(sim.demand)} <small>%</small>`;
  $('valveOutput').innerHTML = `${num(sim.valve)} <small>%</small>`;
  $('sizeOutput').innerHTML = `${num(sim.diameter, 2)} <small>m</small>`;
  for (const id of ['powerSlider', 'valveSlider', 'sizeSlider']) { const el = $(id); el.style.setProperty('--range', `${(el.value - el.min) / (el.max - el.min) * 100}%`); }
  $('ratedPower').textContent = num(sim.ratedPower);
  $('engineMass').textContent = mission ? '干重 10,000' : Math.round(sim.engineMass).toLocaleString('en-US');
  $('hydrogenButton').classList.toggle('active', sim.propellant === 'hydrogen');
  $('waterButton').classList.toggle('active', sim.propellant === 'water');
  $('hydrogenButton').setAttribute('aria-pressed', sim.propellant === 'hydrogen');
  $('waterButton').setAttribute('aria-pressed', sim.propellant === 'water');
}

function render() {
  $('missionTime').textContent = 'T+ ' + clock(mission ? mission.elapsed : sim.time); $('screenTime').textContent = clock(sim.time);
  $('runState').textContent = mission?.complete ? '挑战已结算' : paused ? '模拟暂停' : MODE[sim.mode];
  const isDanger = sim.mode === 'SCRAM' || sim.mode === 'DAMAGED';
  $('runLed').className = 'tiny-light on ' + (isDanger ? 'red' : paused || !sim.isActive ? 'amber' : 'green');
  $('thrustValue').textContent = num(sim.thrust, 1); $('powerValue').textContent = num(sim.power);
  $('temperatureValue').textContent = num(sim.measuredTemperature); $('pressureValue').textContent = num(sim.pressure, 2);
  $('flowValue').textContent = num(sim.flow, 2); $('velocityValue').textContent = num(sim.exhaustVelocity / 1000, 2);
  $('temperatureValue').style.color = sim.measuredTemperature > 3050 ? '#e0a17a' : '';
  const bars = { thrust: sim.thrust / (sim.propellant === 'hydrogen' ? 140 : 150) / sim.scale, power: sim.power / sim.ratedPower, temperature: sim.measuredTemperature / 3500, pressure: sim.pressure / 8, flow: sim.flow / sim.ratedFlow, velocity: sim.exhaustVelocity / 10000 };
  for (const [key, value] of Object.entries(bars)) $(key + 'Bar').style.width = `${Math.min(100, Math.max(0, value * 100))}%`;
  drawGauge('temperatureGauge', sim.measuredTemperature / 1000, 4, 2); drawGauge('pressureGauge', sim.pressure, 8, 2);
  $('tankPercent').textContent = num(sim.fuelPercent, 1) + '%'; $('tankLabel').textContent = sim.prop.symbol + ' / ' + sim.prop.label;
  $('tankMass').textContent = Math.round(sim.fuel).toLocaleString('en-US') + ' kg';
  [...$('tankSegments').children].forEach((segment, i) => segment.classList.toggle('empty', i >= Math.ceil(sim.fuelPercent / 5)));
  for (const [id, label, , color, active] of sim.lamps) {
    const el = $('lamp-' + id); const on = lampTest || active;
    el.classList.toggle('on', on); el.classList.toggle('flashing', active && (color === 'red' || color === 'yellow') && !sim.acknowledged && !lampTest);
    el.setAttribute('aria-label', label + (on ? '：亮' : '：灭'));
  }
  const alarms = sim.lamps.filter(l => l[4] && ['red', 'yellow', 'amber'].includes(l[3]) && l[0] !== 'decay');
  $('healthText').textContent = sim.mode === 'DAMAGED' ? '堆芯受损 · 试验终止' : alarms.length ? `${alarms.length} 项告警 ${sim.acknowledged ? '· 已确认' : '· 待处理'}` : sim.isActive ? '所有子系统正常' : sim.coreTemperature > 500 ? '余热冷却进行中' : '所有子系统就绪';
  $('healthLed').className = 'tiny-light on ' + (alarms.length ? 'red' : 'green');
  $('footerPropellant').textContent = sim.propellant === 'hydrogen' ? 'LH₂ CYCLE' : 'H₂O CYCLE';
  $('mfdStatus').textContent = paused ? 'Ⅱ SIMULATION PAUSED' : alarms.length ? `! ${alarms.length} ACTIVE ALERT` : '● TELEMETRY LIVE';
  $('mfdStatus').style.color = alarms.length ? C.amber : '';
  $('runButton').innerHTML = sim.isActive ? '<i>■</i><span>正常停机<small>SHUTDOWN SEQUENCE</small></span>' : '<i>▶</i><span>启动试车<small>START TEST SEQUENCE</small></span>';
  $('runButton').classList.toggle('start-ready', !sim.isActive);
  $('runButton').disabled = sim.mode === 'DAMAGED' || Boolean(mission?.complete || mission?.autoReason);
  for (const [id, key] of [['pumpToggle', 'pump'], ['coolingToggle', 'cooling'], ['autoToggle', 'autoProtection']]) {
    $(id).classList.toggle('on', sim[key]); $(id).setAttribute('aria-pressed', sim[key]);
  }
  // Keep configuration controls discoverable; activation explains the live interlock.
  $('sizeSlider').disabled = Boolean(mission && (sim.diameterLocked || mission.complete));
  $('sizeSlider').setAttribute('aria-disabled', !sim.canConfigure || sim.diameterLocked);
  $('hydrogenButton').disabled = $('waterButton').disabled = Boolean(mission);
  $('hydrogenButton').title = $('waterButton').title = mission ? '本局推进剂已锁定' : sim.canConfigure ? '选择推进剂' : '请先停机，等待热功率低于 5 MW';
  for (const id of ['powerSlider', 'valveSlider', 'pumpToggle', 'coolingToggle', 'autoToggle', 'scramButton', 'faultButton']) $(id).disabled = Boolean(mission?.complete);
  document.querySelector('.instrument-rack').classList.toggle('controls-frozen', Boolean(mission?.complete));
  $('resetButton').textContent = mission ? '↺ 重试挑战' : '↺ 重置试验';
  if (lastLogId !== sim.eventId) {
    $('eventLog').innerHTML = sim.events.slice(0, 20).map(e => `<div class="event-entry ${e.severity}"><time>${clock(e.time).slice(3)}</time><span>${safe(e.message)}</span></div>`).join('');
    lastLogId = sim.eventId;
  }
  renderMission();
}

function resetUIClock() {
  paused = false; speed = 1; lastFrame = performance.now(); motionTime = 0;
  updatePauseButton(); $('speedButton').textContent = '1×'; lastLogId = -1; resultShown = false;
}

function beginMission(type, propellant, diameter, fuelLoad) {
  mission = new NTRChallenge(sim, { type, propellant, diameter, fuelLoad });
  resetUIClock(); setPage('overview'); updateSliders(); render();
  $('challengeDialog').close();
  $('missionPanel').scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
  toast('挑战已装载 · 冷态准备不计时，首次点火后开始计时');
}

function updateChallengeSetup() {
  document.querySelectorAll('[data-challenge]').forEach(button => { const on = button.dataset.challenge === selectedChallenge; button.classList.toggle('selected', on); button.setAttribute('aria-pressed', on); });
  document.querySelectorAll('[data-loadout]').forEach(button => { const on = button.dataset.loadout === selectedPropellant; button.classList.toggle('selected', on); button.setAttribute('aria-pressed', on); });
  const diameter = Number($('challengeSizeSlider').value);
  $('challengeSizeSlider').style.setProperty('--range', `${(diameter - .8) / 1.6 * 100}%`);
  $('challengeSizeOutput').textContent = num(diameter, 2) + ' m';
  $('challengeRatedPower').textContent = num(600 * (diameter / 1.4) ** 2) + ' MW';
  const precision = selectedChallenge === 'precision';
  const maximum = NTR_CHALLENGE_CAPACITIES[selectedPropellant], load = precision ? selectedFuelLoads[selectedPropellant] : maximum;
  $('fuelLoadControl').hidden = !precision;
  $('fuelLoadInput').max = $('fuelLoadSlider').max = maximum;
  $('fuelLoadInput').value = $('fuelLoadSlider').value = load;
  $('fuelLoadInput').setAttribute('aria-invalid', 'false'); $('fuelLoadInput').setCustomValidity('');
  $('beginChallengeButton').disabled = false;
  $('fuelLoadSlider').style.setProperty('--range', `${(load - 10) / (maximum - 10) * 100}%`);
  $('fuelLoadMax').textContent = points(maximum) + ' kg';
  $('loadoutCost').textContent = '装载成本 −' + points(load * NTR_FUEL_COSTS[selectedPropellant]) + ' 分';
  $('loadoutCost').classList.remove('invalid');
  $('fuelPresets').innerHTML = (selectedPropellant === 'hydrogen' ? [500, 1000, 2000] : [1000, 3000, 5000]).map(value => `<button data-fuel-preset="${value}" class="${value === load ? 'selected' : ''}">${points(value)} kg</button>`).join('');
  $('hydrogenLoadLabel').textContent = precision ? '装载 −5 分 / kg' : '10,000 kg';
  $('waterLoadLabel').textContent = precision ? '装载 −2 分 / kg' : '30,000 kg';
  $('loadoutMass').textContent = num((10000 + load) / 1000, 2) + ' t';
  $('challengeBrief').textContent = selectedChallenge === 'endurance'
    ? '每 1 m/s Δv 得 10 分。耗尽推进剂后自动停堆并冷却结算，也可在低于 800 K 时提前结算。每 100 秒扣 1%；每损失 10% 耐久扣 5%。'
    : '固定目标 325 m/s。原始分 = 100,000 − 装载成本 + 剩余推进剂返分。液氢每 kg 扣 5 分，水扣 2 分，每剩 1 kg 均返 1 分。误差、时间和耐久修正继续适用，低于 800 K 才可结算。';
}

function changeFuelLoad(value) {
  const maximum = NTR_CHALLENGE_CAPACITIES[selectedPropellant];
  if (!Number.isInteger(value) || value < 10 || value > maximum) {
    const message = '请输入 10–' + points(maximum) + ' kg 之间的整数';
    $('fuelLoadInput').setAttribute('aria-invalid', 'true'); $('fuelLoadInput').setCustomValidity(message);
    $('beginChallengeButton').disabled = true; $('loadoutCost').textContent = message; $('loadoutCost').classList.add('invalid');
    return;
  }
  selectedFuelLoads[selectedPropellant] = value; updateChallengeSetup();
}

function openChallengeSetup() {
  selectedChallenge = mission?.type || selectedChallenge;
  selectedPropellant = mission?.propellant || sim.propellant;
  if (mission?.type === 'precision') selectedFuelLoads[mission.propellant] = mission.initialFuel;
  $('challengeSizeSlider').value = sim.diameter;
  updateChallengeSetup(); $('challengeDialog').showModal();
}

function renderMission() {
  $('missionPanel').hidden = !mission; $('settleButton').hidden = !mission;
  document.querySelector('.operations-content').classList.toggle('has-mission', Boolean(mission));
  $('sandboxModeButton').classList.toggle('active', !mission); $('sandboxModeButton').setAttribute('aria-pressed', !mission);
  $('challengeModeButton').classList.toggle('active', Boolean(mission)); $('challengeModeButton').setAttribute('aria-pressed', Boolean(mission));
  $('modeDescription').textContent = mission ? '推进剂锁定 · 一次航行，一份成绩' : '自由试车 · 自定义参数与故障';
  if (!mission) return;
  const info = NTR_CHALLENGE_TYPES[mission.type], score = mission.result || mission.liveScore;
  $('missionCode').textContent = info.code + ' / ' + sim.prop.symbol;
  $('missionName').textContent = info.title;
  $('missionStage').textContent = mission.complete ? '挑战完成' : paused ? '模拟暂停' : !mission.started ? '冷态准备' : mission.autoReason ? '自动冷却结算' : sim.isActive ? '推进加速' : '滑行 / 冷却';
  $('missionPanel').classList.toggle('finished', mission.complete);
  $('missionPanel').classList.toggle('is-burning', sim.thrust > .1 && !mission.complete && !paused);
  $('flightDv').textContent = num(mission.deltaV, 2);
  $('flightAcceleration').textContent = num(mission.acceleration, 3);
  $('flightDistance').textContent = num(mission.distance / 1000, 2);
  $('flightMass').textContent = num(mission.mass / 1000, 2);
  $('flightScore').textContent = points(score.total);
  $('flightScoreLabel').textContent = mission.complete ? '最终得分' : '当前预计得分';
  $('flightTargetLabel').textContent = mission.type === 'precision' ? '目标速度增量' : '挑战目标';
  $('flightTarget').textContent = mission.target === null ? '∞' : num(mission.target);
  $('flightTargetUnit').textContent = mission.target === null ? 'MAX Δv' : 'm/s';
  const progress = Math.min(1, Math.max(0, mission.target ? mission.deltaV / mission.target : 1 - sim.fuel / mission.initialFuel));
  $('flightProgressFill').style.width = progress * 100 + '%';
  $('flightShip').style.left = (3 + progress * 94) + '%';
  $('flightEndMarker').textContent = mission.target === null ? '∞' : '⊕';
  $('flightProgressLabel').textContent = mission.target === null ? '推进剂使用进度 ' + num(progress * 100, 1) + '%' : '变轨完成度 ' + num(mission.deltaV / mission.target * 100, 2) + '%';
  $('flightError').textContent = mission.target === null ? '尽可能获得更高 Δv' : mission.remainingError >= 0 ? '距目标 ' + num(mission.remainingError, 2) + ' m/s' : '超调 ' + num(-mission.remainingError, 2) + ' m/s';
  $('flightError').classList.toggle('overshot', mission.target !== null && mission.remainingError < 0);
  $('flightMassNote').textContent = '干重＋载荷 10.00 t · ' + sim.prop.symbol + ' 初装 ' + points(mission.initialFuel) + ' / 剩余 ' + points(sim.fuel, 1) + ' kg';
  $('flightHint').textContent = mission.complete ? '已结算 · 可以查看报告、复盘遥测或开始新挑战'
    : !mission.started ? '冷启动：开启泵与冷却 → 主阀约 70% → 功率约 60% → 启动试车'
    : mission.autoReason ? mission.autoReason + ' · 保持冷却开启，低于 800 K 自动结算（当前 ' + num(sim.coreTemperature) + ' K）'
    : !sim.isActive ? '余热仍可能产生 Δv · 关闭主阀可减少推进剂消耗，保持冷却回路开启'
    : mission.target && mission.remainingError < 0 ? '已超调！停止推进并保持冷却，低于 800 K 后结算'
    : mission.target && mission.remainingError < Math.min(300, mission.target * .15) ? '接近目标！提前降功率，预留停机后余热产生的额外 Δv'
    : '持续监控温压和耐久 · 停机后冷却至低于 800 K，才能结算';
  const settle = $('settleButton'); settle.classList.toggle('locked', !mission.canSettle && !mission.complete); settle.classList.toggle('complete', mission.complete);
  settle.querySelector('span').textContent = mission.complete ? '查看结算报告' : '结算本次变轨';
  $('settleHint').textContent = mission.complete ? points(score.total) + ' PTS' : !mission.started ? '等待首次点火' : mission.canSettle ? '温度合格 · 可结算' : num(sim.coreTemperature) + ' K / 需 < 800 K';
  if (mission.complete && !resultShown) { leaderboard.add(mission.result); resultShown = true; showResult(); }
}

function showResult() {
  if (!mission?.result) return;
  const r = mission.result;
  $('resultMission').textContent = NTR_CHALLENGE_TYPES[r.type].code + ' / ' + sim.prop.symbol + ' / ' + NTR_RELEASE.label + ' / ' + r.reason;
  $('resultTitle').textContent = r.type === 'precision' && r.error < 1 ? '精确注入，任务完成。' : '本次变轨，已记录。';
  $('resultTotal').textContent = points(r.total);
  const settledTemperature = r.temperature < 800 && Math.round(r.temperature * 100) / 100 >= 800 ? '＜800' : num(r.temperature, 2);
  const metrics = [['最终 Δv', num(r.deltaV, 2) + ' m/s'], [r.target === null ? '飞行距离' : '目标 / 绝对误差', r.target === null ? num(r.distance / 1000, 2) + ' km' : num(r.target) + ' / ' + num(r.error, 2) + ' m/s'], ['初装 / 剩余推进剂', points(r.initialFuel) + ' / ' + points(r.fuel, 2) + ' kg'], ['任务用时（含冷却）', num(r.elapsed, 1) + ' s'], ['剩余耐久', num(r.integrity, 1) + '%'], ['结算堆芯温度', settledTemperature + ' K']];
  $('resultMetrics').innerHTML = metrics.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
  const row = (label, detail, value, penalty = false) => `<div class="score-row ${penalty ? 'penalty' : ''}"><span>${label}<small>${detail}</small></span><b>${value}</b></div>`;
  let rows = r.type === 'endurance' ? row('Δv 得分', '10 分 / m/s', '+' + points(r.dvPoints, 2))
    : row('基础分', 'PRECISION', '+' + points(r.basePoints)) + row('推进剂装载成本', points(r.initialFuel) + ' kg × ' + r.fuelUnitCost + ' 分/kg', '−' + points(r.loadingCost, 2), true) + row('剩余推进剂返分', '1 分 / kg', '+' + points(r.fuelPoints, 2)) + row('修正前原始分', 'BASE SUBTOTAL', points(r.base, 2));
  if (r.type === 'precision') rows += row('速度误差扣分', num(r.error, 2) + ' m/s · ' + num(r.errorPenalty * 100, 2) + '%', '−' + points(r.errorDeduction, 2), true);
  rows += row('耗时扣分', num(r.elapsed, 1) + ' s · ' + num(r.timePenalty * 100, 2) + '%', '−' + points(r.timeDeduction, 2), true);
  rows += row('耐久扣分', '每损失 10% 扣 5% · ' + num(r.durabilityPenalty * 100, 2) + '%', '−' + points(r.durabilityDeduction, 2), true);
  rows += `<div class="score-row total"><span>最终得分<small>向下取整</small></span><b>${points(r.total)}</b></div>`;
  $('scoreBreakdown').innerHTML = rows;
  $('resultFormula').textContent = `${points(r.base, 2)} × ${num(1 - r.errorPenalty, 4)}（精度）× ${num(1 - r.timePenalty, 4)}（时间）× ${num(1 - r.durabilityPenalty, 4)}（耐久）`;
  $('resultLeaderboard').innerHTML = rankingTable(leaderboard.top(r.type, 'all', 3), true);
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('resultDialog').showModal();
}

function rankingTable(records, compact = false) {
  if (!records.length) return '<div class="ranking-empty">当前版本尚无已结算的飞行记录。完成挑战后自动入榜。</div>';
  const rows = records.map((record, index) => `<tr class="${record.id === mission?.result?.id ? 'current-flight' : ''}"><td>${index + 1}</td><td>${NTR_PROPELLANTS[record.propellant].symbol}</td>${compact ? '' : `<td>${points(record.initialFuel)} kg</td><td>${num(record.deltaV, 2)}</td><td>${num(record.elapsed, 1)} s</td>`}<td class="rank-score">${points(record.total)}</td></tr>`).join('');
  return `<table class="ranking-table"><thead><tr><th>#</th><th>推进剂</th>${compact ? '' : '<th>加注量</th><th>Δv / m/s</th><th>耗时</th>'}<th>得分</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderLeaderboard() {
  $('leaderboardTable').innerHTML = rankingTable(leaderboard.top($('leaderboardMode').value, $('leaderboardPropellant').value));
  $('leaderboardNote').textContent = leaderboard.persistent ? '仅保存于当前浏览器。' + NTR_RELEASE.label + ' 与其他版本独立排行，同分时用时更短者优先。' : '当前环境无法持久保存，成绩暂存于本次会话。不同版本独立排行。';
}

function openLeaderboard() {
  $('leaderboardMode').value = mission?.type || 'precision'; renderLeaderboard();
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); $('leaderboardDialog').showModal();
}

function setPage(value) {
  page = value; $('mfdTitle').textContent = pageNames[page];
  document.querySelectorAll('[data-page]').forEach(button => { const selected = button.dataset.page === value; button.classList.toggle('selected', selected); button.setAttribute('aria-selected', selected); });
  $('screenHint').textContent = { overview: 'NTR–II · CLOSED EXPANDER CYCLE', thermal: 'THERMAL CIRCUIT · TEMPERATURE IN K', propulsion: 'VACUUM PERFORMANCE · IDEALIZED MODEL', trend: '120 SEC HISTORY · INDEPENDENT SCALES', diagnostics: 'BUILT-IN TEST · INDEPENDENT SENSOR CH.' }[page];
}

// CRT drawing uses a fixed logical coordinate system for clear, stable layout.
function text(value, x, y, size = 10, color = C.green, align = 'left') {
  ctx.fillStyle = color; ctx.font = `${size}px ${mono}`; ctx.textAlign = align; ctx.fillText(value, x, y);
}
function line(points, color = C.dim, width = 1, dash = []) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); ctx.setLineDash([]);
}
function rect(x, y, w, h, color = C.dim, fill = null, radius = 0) {
  ctx.beginPath(); if (radius) ctx.roundRect(x, y, w, h, radius); else ctx.rect(x, y, w, h);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
}
function circle(x, y, r, color = C.green, fill = null) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
}
function arrow(x, y, direction = 'right', color = C.green) {
  ctx.save(); ctx.translate(x, y); ctx.rotate({ right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[direction]);
  line([[-5, -3], [0, 0], [-5, 3]], color); ctx.restore();
}
function flowLine(points, color = C.green) {
  line(points, C.faint, 3);
  ctx.lineDashOffset = reducedMotion ? 0 : -motionTime * 15;
  line(points, color, 1.1, [5, 10]); ctx.lineDashOffset = 0;
}
function miniMetric(label, value, unit, x, y, color = C.bright) {
  text(label, x, y, 8, C.dim); text(value, x, y + 25, 22, color); text(unit, x + ctx.measureText(value).width + 7, y + 24, 9, C.dim);
}

function drawOverview() {
  // Subtle drafting grid and reference marks.
  ctx.globalAlpha = .15;
  for (let x = 28; x < 670; x += 25) for (let y = 65; y < 330; y += 25) { ctx.fillStyle = C.green; ctx.fillRect(x, y, 1, 1); }
  ctx.globalAlpha = 1;
  line([[35, 203], [647, 203]], C.faint, .7, [3, 6]);
  text('ENGINE SCHEMATIC', 32, 69, 8, C.dim); text('SECTION A–A', 648, 69, 8, C.dim, 'right');

  // Propellant tank.
  rect(61, 112, 64, 102, C.green, '#17291e', 22);
  ctx.save(); ctx.beginPath(); ctx.roundRect(65, 116, 56, 94, 18); ctx.clip();
  ctx.fillStyle = '#587e493b'; ctx.fillRect(65, 210 - 94 * sim.fuelPercent / 100, 56, 100); ctx.restore();
  line([[67, 134], [119, 134]], C.dim); line([[67, 192], [119, 192]], C.dim);
  text(sim.prop.symbol, 93, 161, 18, C.bright, 'center'); text('TANK', 93, 179, 8, C.dim, 'center');
  text(num(sim.prop.inlet) + ' K', 93, 240, 9, C.blue, 'center'); text('PROPELLANT', 93, 254, 7, C.dim, 'center');
  flowLine([[125, 162], [164, 162]], C.blue); arrow(150, 162, 'right', C.blue);

  // Feed turbopump.
  const pumpColor = sim.faults.has('pump') || !sim.pump ? C.red : C.blue;
  circle(183, 162, 19, pumpColor, C.bg); circle(183, 162, 7, pumpColor);
  ctx.save(); ctx.translate(183, 162); ctx.rotate(sim.pump && !paused ? motionTime * 1.2 : 0);
  for (let i = 0; i < 3; i++) { ctx.rotate(Math.PI * 2 / 3); line([[0, -7], [10, -11], [5, -15]], pumpColor); } ctx.restore();
  text('TURBOPUMP', 183, 204, 7, C.dim, 'center');
  text(num(sim.flow, 1) + ' kg/s', 183, 219, 9, pumpColor, 'center');
  flowLine([[202, 162], [241, 162], [241, 134], [308, 134], [308, 155]], C.blue);
  arrow(242, 146, 'up', C.blue); arrow(293, 134, 'right', C.blue);
  // Main valve symbol.
  line([[218, 153], [232, 169], [232, 153], [218, 169], [218, 153]], sim.faults.has('valve') ? C.red : C.blue);

  // Reactor pressure vessel and shield.
  rect(264, 145, 125, 126, C.green, '#192a1e', 14);
  rect(272, 152, 109, 112, C.dim, null, 9);
  line([[281, 144], [281, 129], [365, 129], [365, 144]], C.dim);
  for (let i = 0; i < 5; i++) { const x = 285 + i * 20; line([[x, 145], [x, 137]], C.green, 2); }
  text('REACTOR CORE', 327, 106, 9, C.green, 'center'); text('Ø ' + num(sim.diameter, 2) + ' m', 327, 121, 8, C.dim, 'center');
  const hot = Math.min(1, Math.max(0, (sim.coreTemperature - 293) / 2500));
  const glow = ctx.createRadialGradient(327, 206, 5, 327, 206, 65);
  glow.addColorStop(0, `rgba(206,165,90,${hot * .22})`); glow.addColorStop(1, 'rgba(206,165,90,0)');
  ctx.fillStyle = glow; ctx.fillRect(267, 150, 120, 118);
  for (let i = 0; i < 7; i++) {
    const x = 286 + i * 12;
    rect(x, 165, 6, 84, hot > .25 ? C.amber : C.dim, hot > .25 ? '#ad86492c' : null, 2);
    for (let j = 0; j < 5; j++) line([[x, 178 + j * 14], [x + 6, 178 + j * 14]], hot > .25 ? '#a58d5b' : C.dim);
  }
  // Control drum, regenerative cooling jacket, and nozzle.
  rect(254, 176, 8, 63, C.dim, '#2c3b27', 2); rect(392, 176, 8, 63, C.dim, '#2c3b27', 2);
  const outline = [[400, 182], [425, 182], [447, 194], [461, 191], [494, 172], [551, 142], [566, 139], [566, 266], [551, 263], [494, 233], [461, 214], [447, 211], [425, 224], [400, 224]];
  line([...outline, outline[0]], C.green, 1.4);
  line([[400, 191], [425, 191], [447, 202], [461, 201], [503, 179], [559, 148]], C.dim);
  line([[400, 215], [425, 215], [447, 205], [461, 206], [503, 228], [559, 257]], C.dim);
  line([[571, 139], [571, 266]], C.green, 2);
  // Moving exhaust streaks stay within the nozzle silhouette.
  if (sim.thrust > .5) {
    ctx.save(); ctx.beginPath(); ctx.moveTo(408, 195); ctx.lineTo(446, 202); ctx.lineTo(568, 150); ctx.lineTo(645, 161); ctx.lineTo(645, 248); ctx.lineTo(568, 257); ctx.lineTo(446, 205); ctx.lineTo(408, 213); ctx.closePath(); ctx.clip();
    const exhaust = ctx.createLinearGradient(414, 0, 644, 0); exhaust.addColorStop(0, '#d4bc7933'); exhaust.addColorStop(.45, '#bed7a32b'); exhaust.addColorStop(1, '#9ccf9d00');
    ctx.fillStyle = exhaust; ctx.fillRect(410, 142, 235, 125);
    for (let i = 0; i < 14; i++) { const offset = reducedMotion ? i * 18 : ((motionTime * 50 + i * 18) % 210); const x = 435 + offset; const fan = (x - 435) / 200; const y = 203 + Math.sin(i * 8.3) * fan * 44; line([[x, y], [x + 13, y + (y - 203) * .05]], '#9cbf8977', .7); }
    ctx.restore();
  }
  text('REGENERATIVE NOZZLE', 502, 294, 8, C.dim, 'center');
  flowLine([[565, 270], [565, 283], [407, 283], [407, 258]], sim.cooling && !sim.faults.has('cooling') ? C.blue : C.red);
  text(num(sim.pressure, 2) + ' MPa', 450, 247, 9, C.green, 'center');
  line([[327, 274], [327, 294], [279, 294]], C.dim); text(num(sim.measuredTemperature) + ' K', 271, 297, 11, C.amber, 'right');

  line([[32, 325], [648, 325]], C.faint);
  miniMetric('SPECIFIC IMPULSE', num(sim.isp), 's', 40, 347);
  miniMetric('CORE INTEGRITY', num(sim.integrity, 1), '%', 260, 347, sim.integrity < 90 ? C.amber : C.bright);
  miniMetric('EXHAUST TEMPERATURE', num(Math.max(sim.prop.inlet, sim.coreTemperature - 180)), 'K', 464, 347, C.amber);
}

function drawThermal() {
  text('REACTOR HEAT → PROPELLANT → KINETIC ENERGY', 34, 72, 9, C.dim);
  const coolingColor = sim.cooling && !sim.faults.has('cooling') ? C.blue : C.red;
  flowLine([[127, 170], [254, 170]], C.blue); arrow(210, 170, 'right', C.blue);
  flowLine([[397, 170], [544, 170]], C.amber); arrow(490, 170, 'right', C.amber);
  flowLine([[563, 221], [563, 276], [93, 276], [93, 221]], coolingColor);
  arrow(348, 276, 'left', coolingColor); arrow(93, 245, 'up', coolingColor);
  rect(42, 117, 111, 104, C.blue, '#142820', 4); text('PROPELLANT', 98, 143, 9, C.blue, 'center'); text(sim.prop.symbol, 98, 176, 23, C.bright, 'center'); text(num(sim.prop.inlet) + ' K INLET', 98, 201, 8, C.dim, 'center');
  rect(255, 111, 142, 118, C.amber, '#302c1e44', 4); text('REACTOR', 326, 136, 10, C.amber, 'center'); text(num(sim.measuredTemperature) + ' K', 326, 174, 25, C.amber, 'center'); text(num(sim.power) + ' MW THERMAL', 326, 207, 9, C.green, 'center');
  rect(518, 117, 115, 104, C.green, '#192b1d', 4); text('NOZZLE', 575, 143, 10, C.green, 'center'); text(num(sim.exhaustVelocity / 1000, 2), 575, 177, 26, C.bright, 'center'); text('km/s EXHAUST', 575, 201, 8, C.dim, 'center');
  text(num(sim.flow, 2) + ' kg/s', 205, 155, 9, C.blue, 'center'); text(num(sim.pressure, 2) + ' MPa', 456, 155, 9, C.amber, 'center');
  rect(265, 255, 125, 43, coolingColor, C.bg, 4); text('COOLANT LOOP', 327, 272, 8, coolingColor, 'center'); text(num(sim.coolantTemperature) + ' K', 327, 289, 12, coolingColor, 'center');
  line([[33, 326], [647, 326]], C.faint);
  miniMetric('FEED PUMP', sim.pump ? num(sim.faults.has('pump') ? 23 : 100) : '0', '%', 40, 347, C.blue);
  miniMetric('HEAT EXCHANGE', sim.cooling && !sim.faults.has('cooling') ? 'NOMINAL' : 'DEGRADED', '', 255, 347, coolingColor);
  miniMetric('DECAY HEAT', num(sim.decayPower, 2), 'MW', 482, 347, C.amber);
}

function drawPropulsion() {
  text('VACUUM PERFORMANCE / ' + sim.prop.symbol, 34, 72, 9, C.dim);
  miniMetric('NET THRUST', num(sim.thrust, 1), 'kN', 42, 108);
  miniMetric('SPECIFIC IMPULSE', num(sim.isp), 's', 252, 108);
  miniMetric('TOTAL IMPULSE', num(sim.totalImpulse / 1000, 2), 'MN·s', 462, 108);
  line([[33, 159], [647, 159]], C.faint);
  text('EXHAUST VELOCITY / CORE TEMPERATURE', 42, 184, 8, C.dim);
  const x0 = 62, y0 = 299, width = 548, height = 91;
  for (let i = 0; i <= 4; i++) { const y = y0 - i * height / 4; line([[x0, y], [x0 + width, y]], C.faint, .7); text(String(i * 2.5), x0 - 9, y + 3, 7, C.dim, 'right'); }
  for (let i = 0; i <= 5; i++) { const x = x0 + i * width / 5; text(String(500 + i * 600), x, y0 + 15, 7, C.dim, 'center'); }
  text('km/s', 33, 202, 7, C.dim); text('K', 630, 314, 7, C.dim);
  for (const [type, color] of [['hydrogen', C.green], ['water', C.blue]]) {
    const p = NTR_PROPELLANTS[type]; const points = [];
    for (let i = 0; i <= 80; i++) { const temp = 500 + i / 80 * 3000; const velocity = Math.sqrt(2 * p.gamma / (p.gamma - 1) * p.gasConstant * temp * .87) * .96 / 1000; points.push([x0 + i / 80 * width, y0 - velocity / 10 * height]); }
    line(points, color, type === sim.propellant ? 1.8 : .8, type === sim.propellant ? [] : [3, 4]);
  }
  const px = x0 + Math.max(0, Math.min(1, (sim.coreTemperature - 180 - 500) / 3000)) * width;
  const py = y0 - sim.exhaustVelocity / 1000 / 10 * height; circle(px, py, 4, C.amber, C.bg);
  text('● LH₂', 450, 184, 8, C.green); text('● H₂O', 540, 184, 8, C.blue);
  line([[33, 333], [647, 333]], C.faint);
  if (mission) {
    miniMetric('ACCELERATION', num(mission.acceleration, 3), 'm/s²', 42, 351, C.blue);
    miniMetric('DELTA-V', num(mission.deltaV, 1), 'm/s', 252, 351);
    miniMetric('SPACECRAFT MASS', num(mission.mass / 1000, 2), 't', 462, 351);
  } else {
    miniMetric('MASS FLOW', num(sim.flow, 2), 'kg/s', 42, 351, C.blue);
    miniMetric('CONSUMED', num(sim.consumed, 1), 'kg', 252, 351);
    miniMetric('THRUST / WEIGHT', num(sim.thrust * 1000 / (sim.engineMass * 9.80665), 2), '', 462, 351);
  }
}

function drawTrend() {
  text('TELEMETRY RECORDER / LAST 120 SECONDS', 34, 73, 9, C.dim);
  const chart = { x: 52, y: 109, w: 568, h: 205 };
  for (let i = 0; i <= 4; i++) { const y = chart.y + i * chart.h / 4; line([[chart.x, y], [chart.x + chart.w, y]], C.faint, .7); text(String(100 - i * 25), 41, y + 3, 8, C.dim, 'right'); }
  for (let i = 0; i <= 6; i++) { const x = chart.x + i * chart.w / 6; line([[x, chart.y], [x, chart.y + chart.h]], C.faint, .7, [2, 4]); text('-' + (120 - i * 20) + 's', x, 330, 7, C.dim, 'center'); }
  text('%', 26, 95, 8, C.dim);
  const lines = [['temperature', 4000, C.amber, 'TEMP / 4000K'], ['power', sim.ratedPower, C.green, 'POWER / ' + num(sim.ratedPower) + 'MW'], ['pressure', 8, C.blue, 'PRESS / 8MPa']];
  for (const [key, max, color] of lines) {
    const points = sim.history.map(p => [chart.x + (120 - (sim.time - p.time)) / 120 * chart.w, chart.y + chart.h - Math.min(1, p[key] / max) * chart.h]);
    if (points.length === 1) points.unshift([points[0][0] - 2, points[0][1]]);
    line(points, color, 1.5);
    const last = points.at(-1); if (last) circle(last[0], last[1], 2.5, color, color);
  }
  lines.forEach(([, , color, label], i) => { line([[45 + i * 207, 365], [60 + i * 207, 365]], color, 2); text(label, 66 + i * 207, 368, 8, color); });
}

function drawDiagnostics() {
  text('BUILT-IN TEST / SUBSYSTEM HEALTH', 34, 72, 9, C.dim);
  const faults = [...sim.faults];
  if (!faults.length) {
    rect(34, 95, 612, 54, C.dim, '#24432a44', 2);
    circle(59, 122, 11, C.green); text('✓', 59, 126, 14, C.bright, 'center');
    text('ALL SYSTEMS NOMINAL', 82, 118, 13, C.bright); text('系统自检通过 · 未检测到子系统故障', 82, 137, 10, C.green);
  } else {
    const fault = NTR_FAULTS[faults[0]];
    rect(34, 94, 612, 66, C.red, '#5d34232f', 2);
    text(fault.code + ' / ' + fault.title, 50, 117, 13, C.red);
    text(fault.remedy, 50, 140, 9, C.amber);
  }
  const checks = [
    ['REACTOR / 反应堆', sim.mode === 'DAMAGED' ? 'FAILED' : sim.mode === 'SCRAM' ? 'TRIPPED' : 'NOMINAL', sim.mode === 'DAMAGED' || sim.mode === 'SCRAM'],
    ['FEED PUMP / 供液泵', sim.faults.has('pump') ? 'FAULT P–021' : sim.pump ? 'ONLINE' : 'OFFLINE', sim.faults.has('pump')],
    ['COOLANT / 冷却系统', sim.faults.has('cooling') ? 'FAULT T–014' : sim.cooling ? 'ONLINE' : 'OFFLINE', sim.faults.has('cooling')],
    ['MAIN LINE / 主供液管路', sim.faults.has('leak') ? 'LEAK F–032' : sim.faults.has('valve') ? 'JAM V–008' : 'NOMINAL', sim.faults.has('leak') || sim.faults.has('valve')],
    ['TEMP. SENSOR / 温度传感器', sim.faults.has('sensor') ? 'DRIFT +280K' : 'CALIBRATED', sim.faults.has('sensor')]
  ];
  checks.forEach(([label, value, error], i) => { const y = 185 + i * 29; text(label, 44, y, 10, C.green); text(value, 633, y, 10, error ? C.red : C.bright, 'right'); line([[43, y + 11], [637, y + 11]], C.faint, .5); });
  text('INDEPENDENT TEMP: ' + num(sim.coreTemperature) + ' K', 44, 359, 9, C.amber);
  text('INTEGRITY: ' + num(sim.integrity, 1) + '%', 633, 359, 9, sim.integrity < 90 ? C.red : C.bright, 'right');
  text(faults.length ? `${faults.length} 项注入故障 · 打开「故障注入」进行检修` : 'NO ACTIVE FAULTS / READY FOR TEST', 44, 382, 9, faults.length ? C.amber : C.dim);
}

function drawMFD() {
  const dpr = Math.min(devicePixelRatio || 1, 2); const bounds = canvas.getBoundingClientRect();
  const w = Math.round(bounds.width * dpr), h = Math.round(bounds.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.setTransform(canvas.width / 680, 0, 0, canvas.height / 420, 0, 0);
  ctx.clearRect(0, 0, 680, 420);
  ({ overview: drawOverview, thermal: drawThermal, propulsion: drawPropulsion, trend: drawTrend, diagnostics: drawDiagnostics })[page]();
}

function faultOptions() {
  $('faultOptions').innerHTML = Object.entries(NTR_FAULTS).map(([key, fault]) => `<button class="fault-option ${sim.faults.has(key) ? 'injected' : ''}" data-fault="${key}"><i>${fault.code}</i><span><b>${fault.title}</b><small>${fault.description}</small></span><em>${sim.faults.has(key) ? '修复 ↗' : '注入 + '}</em></button>`).join('');
}

document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page)));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));
$('manualButton').addEventListener('click', () => $('manualDialog').showModal());
$('faultButton').addEventListener('click', () => { faultOptions(); $('faultDialog').showModal(); });
$('faultOptions').addEventListener('click', event => {
  const button = event.target.closest('[data-fault]'); if (!button) return;
  const key = button.dataset.fault;
  if (sim.faults.has(key)) { sim.repairFault(key); toast(NTR_FAULTS[key].title + '已修复'); }
  else { sim.injectFault(key); toast('已注入：' + NTR_FAULTS[key].title); setPage('diagnostics'); }
  faultOptions(); render();
});
$('repairButton').addEventListener('click', () => { toast(sim.repairAll() ? '全部故障已修复' : '当前没有需要修复的故障'); faultOptions(); render(); });
$('runButton').addEventListener('click', () => { const result = sim.isActive ? sim.shutdown() : mission ? mission.startEngine() : sim.start(); toast(result.message); if (result.ok && paused) togglePause(); updateSliders(); render(); });
$('scramButton').addEventListener('click', () => { const result = sim.scram(); toast(result.message); if (paused) togglePause(); render(); });
$('resetButton').addEventListener('click', () => { if (mission) { beginMission(mission.type, mission.propellant, sim.diameter, mission.initialFuel); return; } sim.reset(true); resetUIClock(); updateSliders(); render(); toast('试验已重置 · 设置功率并启动试车'); });
$('ackButton').addEventListener('click', () => { sim.acknowledge(); toast('告警已确认；故障修复后指示灯将熄灭'); render(); });
$('lampTestButton').addEventListener('click', () => { lampTest = true; $('lampTestButton').classList.add('testing'); render(); clearTimeout(lampTimeout); lampTimeout = setTimeout(() => { lampTest = false; $('lampTestButton').classList.remove('testing'); render(); }, 2200); });
function updatePauseButton() { $('pauseButton').textContent = paused ? '▶' : 'Ⅱ'; $('pauseButton').setAttribute('aria-label', paused ? '继续模拟' : '暂停模拟'); }
function togglePause() { paused = !paused; updatePauseButton(); render(); }
$('pauseButton').addEventListener('click', togglePause);
$('speedButton').addEventListener('click', () => { const speeds = mission ? [1, 2, 5, 10, 25] : [1, 2, 5]; speed = speeds[(speeds.indexOf(speed) + 1) % speeds.length]; $('speedButton').textContent = speed + '×'; toast('模拟速度：' + speed + '×'); });
for (const [id, key] of [['pumpToggle', 'pump'], ['coolingToggle', 'cooling'], ['autoToggle', 'autoProtection']]) $(id).addEventListener('click', () => { sim.setSwitch(key, !sim[key]); render(); });
$('powerSlider').addEventListener('input', event => { sim.demand = Number(event.target.value); updateSliders(); });
$('valveSlider').addEventListener('input', event => { sim.valve = Number(event.target.value); updateSliders(); });
$('sizeSlider').addEventListener('input', event => { const result = sim.configure(sim.propellant, Number(event.target.value)); if (!result.ok) toast(result.message); updateSliders(); render(); });
for (const [id, type] of [['hydrogenButton', 'hydrogen'], ['waterButton', 'water']]) $(id).addEventListener('click', () => { if (sim.propellant === type) return; const result = sim.configure(type, sim.diameter); toast(result.message); updateSliders(); render(); });
$('sandboxModeButton').addEventListener('click', () => { if (!mission) return; mission = null; sim.reset(false); resetUIClock(); updateSliders(); render(); toast('已回到沙盒 · 60% 功率稳定试车'); });
$('challengeModeButton').addEventListener('click', openChallengeSetup);
$('newChallengeButton').addEventListener('click', openChallengeSetup);
$('challengeRulesButton').addEventListener('click', () => $('rulesDialog').showModal());
document.querySelectorAll('[data-challenge]').forEach(button => button.addEventListener('click', () => { selectedChallenge = button.dataset.challenge; updateChallengeSetup(); }));
document.querySelectorAll('[data-loadout]').forEach(button => button.addEventListener('click', () => { selectedPropellant = button.dataset.loadout; updateChallengeSetup(); }));
$('challengeSizeSlider').addEventListener('input', updateChallengeSetup);
$('fuelLoadInput').addEventListener('input', event => changeFuelLoad(event.target.valueAsNumber));
$('fuelLoadSlider').addEventListener('input', event => changeFuelLoad(Number(event.target.value)));
$('fuelPresets').addEventListener('click', event => { const button = event.target.closest('[data-fuel-preset]'); if (button) changeFuelLoad(Number(button.dataset.fuelPreset)); });
$('beginChallengeButton').addEventListener('click', () => beginMission(selectedChallenge, selectedPropellant, Number($('challengeSizeSlider').value), selectedChallenge === 'precision' ? selectedFuelLoads[selectedPropellant] : undefined));
$('settleButton').addEventListener('click', () => { if (mission?.complete) { showResult(); return; } if (!mission) return; const result = mission.settle(); if (!result.ok) toast(result.message); render(); });
$('retryChallengeButton').addEventListener('click', () => { $('resultDialog').close(); openChallengeSetup(); });
$('reviewFlightButton').addEventListener('click', () => $('resultDialog').close());
$('leaderboardButton').addEventListener('click', openLeaderboard);
$('resultLeaderboardButton').addEventListener('click', openLeaderboard);
$('leaderboardMode').addEventListener('change', renderLeaderboard);
$('leaderboardPropellant').addEventListener('change', renderLeaderboard);
document.querySelectorAll('[data-release]').forEach(element => { element.textContent = NTR_RELEASE.label; });
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space' && document.activeElement.tagName !== 'BUTTON') { event.preventDefault(); togglePause(); }
  const index = Number(event.key) - 1;
  if (index >= 0 && index < 5) setPage(Object.keys(pageNames)[index]);
  if (/^F[1-5]$/.test(event.key)) { event.preventDefault(); setPage(Object.keys(pageNames)[Number(event.key.slice(1)) - 1]); }
  if (event.key === '?') $('manualDialog').showModal();
});
function frame(now) {
  const delta = Math.min((now - lastFrame) / 1000, 1); lastFrame = now;
  if (!paused) { if (mission) mission.tick(delta * speed); else sim.tick(delta * speed); motionTime += delta * speed; }
  if (now - lastRender >= 90) { render(); lastRender = now; }
  drawMFD(); requestAnimationFrame(frame);
}
// Exposed read-only instrumentation is useful for inspecting the demo in DevTools.
window.nerva = { sim, get mission() { return mission; }, get page() { return page; }, get paused() { return paused; }, get speed() { return speed; } };
updateSliders(); render(); requestAnimationFrame(frame);
