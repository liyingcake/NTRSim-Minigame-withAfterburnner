/* One-dimensional vacuum maneuver game. Dry mass includes engine and payload.
   Scoring penalties are continuous, linear percentages, applied multiplicatively. */
(function (root) {
  'use strict';
  const { TANK, PRICES, loadout } = typeof module !== 'undefined' && module.exports ? require('./systems.js') : root.NTR_SYSTEMS;
  const TYPES = {
    endurance: { title: '无限加速', subtitle: '把每一千克推进剂变成速度', code: '01 / ENDURANCE' },
    precision: { title: '精确入轨注入', subtitle: '在目标速度附近，留下更多推进剂', code: '02 / PRECISION', target: 325, payloadMin: 0, payloadMax: 40000, reward: 2 },
    lunar: { title: '地月转移注入', subtitle: '把货物送上月球航路', code: '03 / LUNAR TRANSFER', target: 2000, payloadMin: 5000, payloadMax: 100000, reward: 10 }
  };
  const CAPACITIES = { hydrogen: Math.floor(TANK.volume * TANK.hydrogen), water: TANK.volume * TANK.water };
  const ENDURANCE_LOADS = { hydrogen: 10000, water: 30000 };
  const DEFAULT_LOADS = { hydrogen: 1000, water: 3000 };
  const FUEL_COSTS = PRICES;
  const PRECISION_TARGET = 325;
  const release = typeof module !== 'undefined' && module.exports ? require('./version.js') : root.NTR_RELEASE;
  let resultSequence = 0;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const formatPoints = (value, places = 0) => Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places }) : '—';

  function calculateScore({ type, deltaV, target, propellant, initialFuel, fuel, initialOxygen = 0, oxygen = 0, payload = 0, elapsed, integrity }) {
    const targeted = type !== 'endurance', info = TYPES[type];
    if (!info || ![deltaV, fuel, oxygen, initialOxygen, payload, elapsed, integrity].every(Number.isFinite)
      || initialOxygen < 0 || oxygen < 0 || oxygen > initialOxygen || payload < 0
      || (targeted && (!Number.isFinite(target) || !FUEL_COSTS[propellant] || !loadout(propellant, initialFuel, initialOxygen).valid || fuel < 0 || fuel > initialFuel || payload < info.payloadMin || payload > info.payloadMax))) throw new TypeError('Invalid challenge score inputs');
    const error = targeted ? Math.abs(deltaV - target) : 0;
    const dvPoints = type === 'endurance' ? Math.max(0, deltaV) * 10 : 0;
    const basePoints = targeted ? 100000 : 0;
    const fuelUnitCost = targeted ? FUEL_COSTS[propellant] : 0;
    const primaryLoadingCost = targeted ? initialFuel * fuelUnitCost : 0;
    const oxygenLoadingCost = targeted ? initialOxygen * PRICES.oxygen : 0;
    const loadingCost = primaryLoadingCost + oxygenLoadingCost;
    const fuelPoints = targeted ? Math.max(0, fuel) + oxygen : 0;
    const payloadUnitReward = targeted ? info.reward : 0, payloadPoints = payload * payloadUnitReward;
    const base = Math.max(0, basePoints + dvPoints + payloadPoints - loadingCost + fuelPoints);
    const errorPenalty = clamp(error / 100, 0, 1);
    const timePenalty = clamp(Math.max(0, elapsed) / 10000, 0, 1);
    const durabilityPenalty = (100 - clamp(integrity, 0, 100)) / 100 * .5;
    const accuracySubtotal = base * (1 - errorPenalty);
    const timeSubtotal = accuracySubtotal * (1 - timePenalty);
    return Object.freeze({ base, basePoints, dvPoints, fuelPoints, fuelUnitCost, primaryLoadingCost, oxygenLoadingCost, loadingCost, payloadPoints, payloadUnitReward, error, errorPenalty, timePenalty, durabilityPenalty,
      errorDeduction: base - accuracySubtotal, timeDeduction: accuracySubtotal - timeSubtotal,
      durabilityDeduction: timeSubtotal * durabilityPenalty,
      total: Math.max(0, Math.floor(timeSubtotal * (1 - durabilityPenalty))) });
  }

  class NTRChallenge {
    constructor(engine, { type = 'endurance', propellant = 'hydrogen', diameter = 1.4, fuelLoad, oxygenLoad = 0, payload = type === 'lunar' ? 5000 : 0 } = {}) {
      if (!TYPES[type] || !CAPACITIES[propellant] || !Number.isFinite(diameter) || diameter < .8 || diameter > 2.4) throw new TypeError('Invalid challenge configuration');
      const initialFuel = fuelLoad ?? (type === 'endurance' ? ENDURANCE_LOADS[propellant] : type === 'lunar' ? (propellant === 'hydrogen' ? 9000 : 60000) : DEFAULT_LOADS[propellant]);
      const tank = loadout(propellant, initialFuel, oxygenLoad), info = TYPES[type];
      if (!Number.isInteger(initialFuel) || !Number.isInteger(oxygenLoad) || !tank.valid || !Number.isInteger(payload)
        || (type === 'endurance' ? payload !== 0 : payload < info.payloadMin || payload > info.payloadMax)) throw new TypeError('Invalid propellant / payload load');
      this.engine = engine; this.type = type; this.propellant = propellant; this.payload = payload; this.baseDryMass = 10000; this.dryMass = this.baseDryMass + payload;
      this.initialFuel = initialFuel; this.initialOxygen = oxygenLoad; this.initialVolume = tank.usedVolume; this.target = info.target ?? null;
      this.state = 'PREPARING'; this.started = false; this.elapsed = 0; this.deltaV = 0;
      this.distance = 0; this.acceleration = 0; this.peakAcceleration = 0; this.result = null; this.autoReason = null;
      this.peaks = { thrust: 0, power: 0, isp: 0, temperature: 293, pressure: 0, flow: 0, afterburnerPower: 0, totalPower: 0, oxygenFlow: 0, nozzleTemperature: 293 };
      this.launchDemand = 0; this.launchValve = 0;
      engine.reset(true); engine.configure(propellant, diameter);
      engine.tankCapacity = this.initialFuel; engine.fuel = this.initialFuel;
      engine.oxygen = engine.initialOxygen = oxygenLoad; engine.oxygenTankInstalled = oxygenLoad > 0;
      engine.oxygenInterlock = oxygenLoad > 0 ? '液氧泵关闭' : '未安装液氧舱';
      engine.propellantLocked = true; engine.demand = 0; engine.valve = 0;
      engine.pump = false; engine.cooling = false;
      engine.events = []; engine.log(TYPES[type].title + ' · 冷态准备');
      engine.log('装载锁定 ' + engine.prop.symbol + ' ' + this.initialFuel.toLocaleString('en-US') + ' kg / LOX ' + oxygenLoad.toLocaleString('en-US') + ' kg');
      engine.log('干重 ' + this.dryMass.toLocaleString('en-US') + ' kg / 容积 ' + tank.usedVolume.toFixed(2) + ' m³');
      engine.history = []; engine.recordSample();
    }
    get mass() { return this.dryMass + this.engine.fuel + this.engine.oxygen; }
    get complete() { return this.state === 'COMPLETE'; }
    get remainingError() { return this.target === null ? null : this.target - this.deltaV; }
    get canSettle() { return this.started && !this.complete && this.engine.coreTemperature < 800; }
    get liveScore() { return calculateScore({ type: this.type, deltaV: this.deltaV, target: this.target, propellant: this.propellant, initialFuel: this.initialFuel, fuel: this.engine.fuel, initialOxygen: this.initialOxygen, oxygen: this.engine.oxygen, payload: this.payload, elapsed: this.elapsed, integrity: this.engine.integrity }); }

    startEngine() {
      if (this.complete) return { ok: false, message: '本次挑战已结算，请开始新挑战' };
      if (this.autoReason) return { ok: false, message: '任务正在自动冷却结算，请保持冷却回路开启' };
      if (this.engine.demand <= 0) return { ok: false, message: '冷启动：请先设定大于 0% 的反应堆功率' };
      const result = this.engine.start();
      if (result.ok && !this.started) {
        this.launchDemand = this.engine.demand; this.launchValve = this.engine.valve; this.launchOxygenValve = this.engine.oxygenValve;
        this.started = true; this.state = 'ACTIVE'; this.engine.diameterLocked = true;
        this.engine.time = 0; this.engine.history = []; this.engine.sampleTimer = 0; this.engine.recordSample();
        this.engine.log('首次点火 · 航行计时开始 / 发动机尺寸锁定');
      }
      return result;
    }

    tick(delta) {
      if (this.complete || !this.started || !Number.isFinite(delta) || delta <= 0) return;
      let remaining = Math.min(delta, 25);
      while (remaining > 1e-8 && !this.complete) {
        const dt = Math.min(.05, remaining), beforeMass = this.mass, previousVelocity = this.deltaV;
        this.engine.tick(dt);
        for (const key of ['thrust', 'power', 'isp', 'pressure', 'afterburnerPower', 'totalPower', 'oxygenFlow', 'nozzleTemperature']) this.peaks[key] = Math.max(this.peaks[key], this.engine[key]);
        this.peaks.flow = Math.max(this.peaks.flow, this.engine.totalFlow);
        this.peaks.temperature = Math.max(this.peaks.temperature, this.engine.coreTemperature);
        // Preserve impulse already delivered during this step if a trip cuts oxygen at its end.
        const accelerationDuringStep = this.engine.stepThrust * 1000 / ((beforeMass + this.mass) / 2);
        this.deltaV += accelerationDuringStep * dt;
        this.distance += (previousVelocity + this.deltaV) * .5 * dt;
        this.elapsed += dt;
        this.acceleration = this.engine.fuel > 0 ? this.engine.thrust * 1000 / this.mass : 0;
        this.peakAcceleration = Math.max(this.peakAcceleration, accelerationDuringStep);
        if (!this.autoReason && (this.engine.fuel <= 0 || this.engine.mode === 'DAMAGED')) {
          this.autoReason = this.engine.fuel <= 0 ? '推进剂耗尽' : '反应堆损毁';
          this.state = 'COOLING';
          if (this.engine.mode !== 'DAMAGED') this.engine.scram('推进剂耗尽 · 自动停堆');
          this.engine.log(this.autoReason + ' · 冷却至低于 800 K 后自动结算', 'warning');
        }
        if (this.autoReason && this.canSettle) this.settle(this.autoReason + ' / 自动结算');
        remaining -= dt;
      }
    }

    settle(reason = '操作员结算') {
      if (this.complete) return { ok: true, message: '本次挑战已结算', result: this.result };
      if (!this.started) return { ok: false, message: '请先完成冷启动，开始本次挑战' };
      if (this.engine.coreTemperature >= 800) return { ok: false, message: '结算联锁：堆芯需低于 800 K；请先停机并保持冷却' };
      const score = this.liveScore;
      this.result = Object.freeze({ ...score, id: Date.now().toString(36) + '-' + (++resultSequence), version: release.version, scoreSchema: release.scoreSchema, type: this.type, propellant: this.propellant, diameter: this.engine.diameter, reason,
        target: this.target, deltaV: this.deltaV, distance: this.distance, elapsed: this.elapsed,
        fuel: this.engine.fuel, initialFuel: this.initialFuel, integrity: this.engine.integrity,
        temperature: this.engine.coreTemperature, peakAcceleration: this.peakAcceleration,
        engineModel: this.engine.engineModel, ratedPower: this.engine.ratedPower,
        baseDryMass: this.baseDryMass, payload: this.payload, dryMass: this.dryMass, initialMass: this.dryMass + this.initialFuel + this.initialOxygen, finalMass: this.mass,
        initialOxygen: this.initialOxygen, oxygen: this.engine.oxygen, consumedOxygen: this.initialOxygen - this.engine.oxygen, initialVolume: this.initialVolume, dividerVolume: this.initialOxygen > 0 ? TANK.divider : 0,
        consumedFuel: this.initialFuel - this.engine.fuel, launchDemand: this.launchDemand, launchValve: this.launchValve, launchOxygenValve: this.launchOxygenValve,
        peakThrust: this.peaks.thrust, peakPower: this.peaks.power, peakIsp: this.peaks.isp,
        peakTemperature: this.peaks.temperature, peakPressure: this.peaks.pressure, peakFlow: this.peaks.flow,
        peakAfterburnerPower: this.peaks.afterburnerPower, peakTotalPower: this.peaks.totalPower, peakOxygenFlow: this.peaks.oxygenFlow, peakNozzleTemperature: this.peaks.nozzleTemperature });
      if (this.engine.isActive) this.engine.shutdown();
      this.engine.controlsLocked = true; this.state = 'COMPLETE'; this.acceleration = 0;
      this.engine.log('挑战完成 · 最终得分 ' + score.total.toLocaleString('en-US'));
      return { ok: true, message: '挑战已结算', result: this.result };
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { NTRChallenge, calculateScore, formatPoints, CHALLENGE_TYPES: TYPES, CHALLENGE_CAPACITIES: CAPACITIES, DEFAULT_LOADS, FUEL_COSTS, PRECISION_TARGET };
  else { root.NTRChallenge = NTRChallenge; root.NTR_CHALLENGE_TYPES = TYPES; root.NTR_CHALLENGE_CAPACITIES = CAPACITIES; root.NTR_DEFAULT_LOADS = DEFAULT_LOADS; root.NTR_FUEL_COSTS = FUEL_COSTS; root.NTR_FORMAT_POINTS = formatPoints; }
})(typeof window !== 'undefined' ? window : globalThis);
