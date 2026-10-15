/* One-dimensional vacuum maneuver game. Dry mass includes engine and payload.
   Scoring penalties are continuous, linear percentages, applied multiplicatively. */
(function (root) {
  'use strict';
  const TYPES = {
    endurance: { title: '无限加速', subtitle: '把每一千克推进剂变成速度', code: '01 / ENDURANCE' },
    precision: { title: '精确入轨注入', subtitle: '在目标速度附近，留下更多推进剂', code: '02 / PRECISION' }
  };
  const CAPACITIES = { hydrogen: 10000, water: 30000 };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function calculateScore({ type, deltaV, target, fuel, elapsed, integrity }) {
    if (!TYPES[type] || ![deltaV, fuel, elapsed, integrity].every(Number.isFinite) || (type === 'precision' && !Number.isFinite(target))) throw new TypeError('Invalid challenge score inputs');
    const error = type === 'precision' ? Math.abs(deltaV - target) : 0;
    const dvPoints = type === 'endurance' ? Math.max(0, deltaV) * 10 : 0;
    const basePoints = type === 'precision' ? 10000 : 0;
    const fuelPoints = type === 'precision' ? Math.max(0, fuel) : 0;
    const base = basePoints + dvPoints + fuelPoints;
    const errorPenalty = clamp(error / 100, 0, 1);
    const timePenalty = clamp(Math.max(0, elapsed) / 10000, 0, 1);
    const durabilityPenalty = (100 - clamp(integrity, 0, 100)) / 100 * .5;
    const accuracySubtotal = base * (1 - errorPenalty);
    const timeSubtotal = accuracySubtotal * (1 - timePenalty);
    return Object.freeze({ base, basePoints, dvPoints, fuelPoints, error, errorPenalty, timePenalty, durabilityPenalty,
      errorDeduction: base - accuracySubtotal, timeDeduction: accuracySubtotal - timeSubtotal,
      durabilityDeduction: timeSubtotal * durabilityPenalty,
      total: Math.max(0, Math.floor(timeSubtotal * (1 - durabilityPenalty))) });
  }

  class NTRChallenge {
    constructor(engine, { type = 'endurance', propellant = 'hydrogen', diameter = 1.4, random = Math.random } = {}) {
      if (!TYPES[type] || !CAPACITIES[propellant] || !Number.isFinite(diameter) || diameter < .8 || diameter > 2.4) throw new TypeError('Invalid challenge configuration');
      this.engine = engine; this.type = type; this.propellant = propellant; this.dryMass = 10000;
      this.initialFuel = CAPACITIES[propellant]; this.target = type === 'precision' ? 2750 + Math.floor(clamp(random(), 0, .999999999) * 101) : null;
      this.state = 'PREPARING'; this.started = false; this.elapsed = 0; this.deltaV = 0;
      this.distance = 0; this.acceleration = 0; this.peakAcceleration = 0; this.result = null; this.autoReason = null;
      engine.reset(true); engine.configure(propellant, diameter);
      engine.tankCapacity = this.initialFuel; engine.fuel = this.initialFuel;
      engine.propellantLocked = true; engine.demand = 0; engine.valve = 0;
      engine.pump = false; engine.cooling = false;
      engine.events = []; engine.log(TYPES[type].title + ' · 冷态准备');
      engine.log('推进剂锁定 ' + engine.prop.symbol + ' / ' + this.initialFuel.toLocaleString('en-US') + ' kg');
      engine.log('干重＋载荷 10,000 kg · 开启泵与冷却后设置功率/主阀');
      engine.history = []; engine.recordSample();
    }
    get mass() { return this.dryMass + this.engine.fuel; }
    get complete() { return this.state === 'COMPLETE'; }
    get remainingError() { return this.target === null ? null : this.target - this.deltaV; }
    get canSettle() { return this.started && !this.complete && this.engine.coreTemperature < 800; }
    get liveScore() { return calculateScore({ type: this.type, deltaV: this.deltaV, target: this.target, fuel: this.engine.fuel, elapsed: this.elapsed, integrity: this.engine.integrity }); }

    startEngine() {
      if (this.complete) return { ok: false, message: '本次挑战已结算，请开始新挑战' };
      if (this.autoReason) return { ok: false, message: '任务正在自动冷却结算，请保持冷却回路开启' };
      if (this.engine.demand <= 0) return { ok: false, message: '冷启动：请先设定大于 0% 的反应堆功率' };
      const result = this.engine.start();
      if (result.ok && !this.started) {
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
        const accelerationDuringStep = this.engine.thrust * 1000 / ((beforeMass + this.mass) / 2);
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
      this.result = Object.freeze({ ...score, type: this.type, propellant: this.propellant, diameter: this.engine.diameter, reason,
        target: this.target, deltaV: this.deltaV, distance: this.distance, elapsed: this.elapsed,
        fuel: this.engine.fuel, initialFuel: this.initialFuel, integrity: this.engine.integrity,
        temperature: this.engine.coreTemperature, peakAcceleration: this.peakAcceleration });
      if (this.engine.isActive) this.engine.shutdown();
      this.engine.controlsLocked = true; this.state = 'COMPLETE'; this.acceleration = 0;
      this.engine.log('挑战完成 · 最终得分 ' + score.total.toLocaleString('en-US'));
      return { ok: true, message: '挑战已结算', result: this.result };
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { NTRChallenge, calculateScore, CHALLENGE_TYPES: TYPES, CHALLENGE_CAPACITIES: CAPACITIES };
  else { root.NTRChallenge = NTRChallenge; root.NTR_CHALLENGE_TYPES = TYPES; root.NTR_CHALLENGE_CAPACITIES = CAPACITIES; }
})(typeof window !== 'undefined' ? window : globalThis);
