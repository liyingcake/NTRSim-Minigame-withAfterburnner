/* A deliberately simplified, deterministic thermal / fluid model for the demo.
   Units inside the model: s, K, MPa, MW, kg/s, m/s, kN. No neutronics model. */
(function (root) {
  'use strict';
  const { TANK, RESIDUAL, residualSupply, loadout, pumpRipple, mixExhaust } = typeof module !== 'undefined' && module.exports ? require('./systems.js') : root.NTR_SYSTEMS;
  const thermo = typeof module !== 'undefined' && module.exports ? require('./thermochemistry.js') : root.NTR_THERMO;
  const flight = typeof module !== 'undefined' && module.exports ? require('./flight-recorder.js') : root.NTR_FLIGHT;
  const nozzle = typeof module !== 'undefined' && module.exports ? require('./nozzle.js') : root.NTR_NOZZLE;
  const PROPELLANTS = {
    hydrogen: { label: '液氢', symbol: 'LH₂', inlet: 20, ratedFlow: thermo.metadata.model.hydrogenRatedFlow, capacity: 6000 },
    water: { label: '水', symbol: 'H₂O', inlet: 293, ratedFlow: 45, capacity: 14000 }
  };
  const FAULTS = {
    pump: { title: '推进剂泵失速', code: 'P–021', description: '泵转速下降，供液与压力衰减，堆芯冷却不足。', remedy: '紧急停堆并修复推进剂泵；保持冷却回路运行。' },
    cooling: { title: '冷却回路失效', code: 'T–014', description: '再生冷却效率下降，堆芯与喷管温度升高。', remedy: '降低功率或停堆，修复冷却回路。' },
    leak: { title: '推进剂管路泄漏', code: 'F–032', description: '部分推进剂流失，喷管流量下降，储量消耗加快。', remedy: '停止试车，修复管路并检查剩余推进剂。' },
    valve: { title: '主阀卡滞', code: 'V–008', description: '主阀卡在 28% 开度，控制指令与实际流量不符。', remedy: '降低反应堆功率，停堆检修主阀。' },
    sensor: { title: '温度传感器漂移', code: 'S–006', description: '温度读数偏高 280 K；独立保护传感器仍正常。', remedy: '对照诊断页的独立温度通道，校准或更换传感器。' }
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const approach = (a, b, dt, tau) => a + (b - a) * (1 - Math.exp(-dt / tau));
  const TELEMETRY_LIMITS = Object.freeze({ temperature: 4000, pressure: 8, isp: 1000 });
  const grade = (value, thresholds) => thresholds.reduce((level, threshold, i) => value >= threshold ? i + 1 : level, 0);
  const warningColor = level => ['green', 'yellow', 'orange', 'red'][level];

  class NTRSimulation {
    constructor() { this.events = []; this.eventId = 0; this.reset(false); }
    get prop() { return PROPELLANTS[this.propellant]; }
    get scale() { return (this.diameter / 1.4) ** 2; }
    get ratedPower() { return 600 * this.scale; }
    get ratedFlow() { return this.prop.ratedFlow * this.scale; }
    get baseEngineMass() { return flight.engineMass(this.diameter); }
    get nozzle() { return nozzle.geometry(this.diameter, this.nozzleSettings); }
    get nozzleMass() { return this.nozzle.mass; }
    get engineMass() { return this.baseEngineMass + this.nozzleMass; }
    get baseDryMass() { return flight.BASE_DRY_MASS; }
    get dryMass() { return this.baseDryMass + this.engineMass + this.payload; }
    get mass() { return this.dryMass + this.fuel + this.oxygen; }
    get acceleration() { return this.thrust * 1000 / this.mass; }
    get engineModel() { return (this.oxygenTankInstalled ? 'LANTR-' : 'NTR-II-') + String(Math.round(this.diameter * 100)).padStart(3, '0') + (this.propellant === 'hydrogen' ? 'H' : 'W'); }
    get fuelCapacity() { return this.tankCapacity || this.prop.capacity; }
    get fuelPercent() { return this.fuel / this.fuelCapacity * 100; }
    get oxygenPercent() { return this.initialOxygen > 0 ? this.oxygen / this.initialOxygen * 100 : 0; }
    get fuelReserve() { return this.fuelCapacity * RESIDUAL.cutoff; }
    get oxygenReserve() { return this.initialOxygen * RESIDUAL.cutoff; }
    get usableFuel() { return Math.max(0, this.fuel - this.fuelReserve); }
    get usableOxygen() { return Math.max(0, this.oxygen - this.oxygenReserve); }
    get fuelExhausted() { return this.usableFuel <= 1e-9; }
    get fuelSupplyFactor() { return residualSupply(this.fuel, this.fuelCapacity); }
    get oxygenSupplyFactor() { return residualSupply(this.oxygen, this.initialOxygen); }
    get fuelPumpEfficiency() { return !this.pump ? 0 : this.fuelSupplyFactor * (this.faults.has('pump') ? .23 : 1); }
    get measuredTemperature() { return this.coreTemperature + (this.faults.has('sensor') ? 280 : 0); }
    get isActive() { return this.mode === 'RUNNING' || this.mode === 'STARTING'; }
    get canConfigure() { return !this.isActive && this.power < 5; }
    get ratedOxygenFlow() { return thermo.metadata.model.oxygenRatedFlow * this.scale; }
    get totalFlow() { return this.flow + this.oxygenFlow; }
    get totalPower() { return this.power + this.afterburnerPower; }
    get gasFilmDrop() {
      const base = this.propellant === 'water' ? 50 : 180;
      return base + ((!this.cooling || this.faults.has('cooling')) ? 600 * Math.min(1, this.power / Math.max(1, this.ratedPower * .2)) : 0);
    }
    get wallHeatCapacity() { return this.nozzleMass * 700 + this.baseEngineMass * 150; }
    get coreHeatCapacity() { return this.baseEngineMass * 390; }
    get dissociationPower() { return this.thermoState?.dissociationPower || 0; }
    get tankState() { return loadout(this.propellant, this.fuel, this.oxygen, this.oxygenTankInstalled); }

    reset(cold = true) {
      this.time = 0; this.propellant = 'hydrogen'; this.diameter = 1.4; this.payload = 0;
      this.nozzleSettings = { ...nozzle.DEFAULTS }; this.nozzleLocked = false;
      this.demand = 60; this.valve = 70; this.pump = true; this.cooling = true; this.autoProtection = true;
      this.tankCapacity = null; this.propellantLocked = false; this.diameterLocked = false; this.controlsLocked = false;
      this.oxygen = 0; this.initialOxygen = 0; this.oxygenConsumed = 0; this.oxygenTankInstalled = false;
      this.oxygenPump = false; this.oxygenValve = 0; this.oxygenFeedFlow = 0; this.oxygenFlow = 0;
      this.commandedFlow = 0; this.commandedOxygenFlow = 0; this.flowRipple = 0; this.oxygenRipple = 0;
      this.afterburnerPower = 0; this.nozzleTemperature = 293; this.mixtureRatio = 0;
      this.nozzleWallTemperature = cold ? 293 : 650; this.nozzleHeatLoad = this.nozzleCoolingPower = this.nozzleRadiationPower = 0;
      this.regenerativePower = this.externalCoolingPower = 0;
      this.wallEnergyRate = 0; this.nozzleEnergy = null; this.thermoState = null;
      this.coreHeatToPropellant = this.coreCoolingPower = this.coreStoredPower = 0;
      this.coreGasEnthalpy = null; this.coreLeakHeat = this.coreOverflowPower = 0;
      this.coreGasEnthalpyAtTemperature = null;
      this.products = { steam: 0, hydrogen: 0, oxygen: 0 }; this.oxygenInterlock = '未安装液氧舱';
      this.faults = new Set(); this.acknowledged = false; this.integrity = 100; this.previousAlarms = new Map();
      this.fuel = this.prop.capacity; this.mode = cold ? 'STANDBY' : 'RUNNING';
      this.power = cold ? 0 : 360; this.flow = cold ? 0 : this.ratedFlow * .7;
      this.feedFlow = this.flow; this.feedNominal = this.flow; this.commandedFlow = this.flow; this.coreTemperature = cold ? 293 : this.equilibriumTemperature();
      this.pressure = 0; this.exhaustVelocity = 0; this.thrust = 0; this.isp = 0;
      this.coolantTemperature = cold ? 293 : 475; this.decayPower = 0; this.protectionTimer = 0;
      this.totalImpulse = 0; this.consumed = 0; this.history = []; this.sampleTimer = 0;
      this.events = []; this.eventId = 0; this.updatePerformance(); this.recordSample();
      this.flight = new flight.FlightRecorder();
      if (!cold) this.flight.begin(this);
      this.log(cold ? '试验复位 · 待机就绪' : '试验开始 · 60% 额定功率');
      this.log('冷却回路 / 推进剂泵 已上线');
      this.log('遥测连接已建立 · 系统自检通过');
    }

    log(message, severity = 'info') {
      this.events.unshift({ id: ++this.eventId, time: this.time, message, severity });
      this.events = this.events.slice(0, 80);
      this.flight?.operation('event', message, 'system', severity);
    }

    setControl(key, value, source = 'panel') {
      if (this.controlsLocked || !['demand', 'valve', 'oxygenValve'].includes(key) || !Number.isFinite(value)) return;
      value = clamp(value, 0, 100);
      if (this[key] === value) return;
      this[key] = value;
      this.flight.operation(key, value, source);
    }

    equilibriumTemperature() {
      // The closed coolant loop can remove residual heat after the feed tank is empty.
      if (!this.isActive && this.flow < this.ratedFlow * .01 && this.cooling && !this.faults.has('cooling')) {
        return clamp(293 + this.power / this.ratedPower * 2200, 293, 4900);
      }
      const available = thermo.metadata.feedEnthalpy[this.propellant] + this.power * 1e6 / Math.max(this.flow, .05);
      const gasTemp = thermo.fromEnthalpy(available, Math.max(1e3, (this.pressure || 4) * 1e6), this.propellant === 'water' ? thermo.metadata.waterRatio : 0).temperature;
      return clamp(gasTemp + (this.power > .1 ? this.gasFilmDrop : 0), 293, 4900);
    }

    start(source = 'operator') {
      if (this.controlsLocked) return { ok: false, message: '本次挑战已结算，请开始新挑战' };
      if (this.isActive) return { ok: false, message: '发动机已在运行' };
      if (this.integrity <= 0) return { ok: false, message: '堆芯受损，请重置试验' };
      if (this.faults.size) return { ok: false, message: '请先修复故障，再重新启动' };
      if (!this.pump || !this.cooling) return { ok: false, message: '启动联锁：请开启推进剂泵和冷却回路' };
      if (this.fuelExhausted) return { ok: false, message: '已达到不可泵送残留量，请重新加注' };
      if (this.valve < 15) return { ok: false, message: '启动联锁：主阀开度至少需要 15%' };
      if (this.demand === 0) this.setControl('demand', 30, 'startup');
      this.mode = 'STARTING'; this.acknowledged = false; this.protectionTimer = 0;
      this.flight.begin(this); this.flight.operation('start', true, source);
      this.log('启动序列执行 · 供液 / 功率爬升');
      return { ok: true, message: '启动序列已执行' };
    }

    shutdown(source = 'operator') {
      if (!this.isActive) return { ok: false, message: '发动机已处于停堆状态' };
      this.mode = 'SHUTDOWN'; this.decayPower = this.power * .015;
      this.flight.operation('shutdown', true, source);
      this.closeOxygen();
      this.log('正常停机 · 保持供液与余热冷却', 'warning');
      return { ok: true, message: '正常停机中，正在带走余热' };
    }

    scram(reason = '操作员执行紧急停堆') {
      if (this.mode === 'SCRAM' || this.mode === 'DAMAGED') return { ok: false, message: '紧急停堆已执行' };
      this.decayPower = Math.max(this.decayPower, this.power * .025);
      this.mode = 'SCRAM'; this.acknowledged = false;
      this.flight.operation('scram', reason, reason === '操作员执行紧急停堆' ? 'operator' : 'system');
      this.closeOxygen();
      this.log(reason + ' · SCRAM', 'danger');
      return { ok: true, message: '紧急停堆已执行，冷却回路保持当前状态' };
    }

    configure(type, diameter) {
      if (this.controlsLocked) return { ok: false, message: '本次挑战已结算，请开始新挑战' };
      if (this.propellantLocked && type !== this.propellant) return { ok: false, message: '挑战中推进剂已锁定；请开始新挑战以更换推进剂' };
      if (this.diameterLocked && diameter !== this.diameter) return { ok: false, message: '首次点火后发动机尺寸锁定；请在新挑战准备阶段调整' };
      if (!this.canConfigure) return { ok: false, message: '配置联锁：请先正常停机，等待热功率低于 5 MW' };
      if (!PROPELLANTS[type] || !Number.isFinite(diameter)) return { ok: false, message: '配置参数无效' };
      if (this.propellant !== type) {
        this.propellant = type; this.fuel = this.prop.capacity; this.consumed = 0;
        this.oxygen = this.initialOxygen = this.oxygenConsumed = 0; this.oxygenTankInstalled = false; this.closeOxygen(); this.tankCapacity = null;
        this.log('推进剂切换为 ' + this.prop.symbol + ' / ' + this.prop.label);
      }
      if (this.diameter !== diameter) {
        this.diameter = clamp(diameter, .8, 2.4);
        this.log('堆芯直径设定 ' + this.diameter.toFixed(2) + ' m');
      }
      this.flight.operation('configure', { propellant: this.propellant, diameter: this.diameter });
      return { ok: true, message: '发动机配置已更新' };
    }

    configureNozzle(settings) {
      if (this.controlsLocked || this.nozzleLocked) return { ok: false, message: '首次点火后喷管几何锁定，请开始新挑战' };
      if (!this.canConfigure) return { ok: false, message: '喷管配置联锁：请先停机，等待核热功率低于 5 MW' };
      const next = { ...this.nozzleSettings, ...settings };
      if (!nozzle.valid(next)) return { ok: false, message: '喷管参数超出范围' };
      this.nozzleSettings = next; this.flight.operation('nozzleConfigure', { ...next, ...this.nozzle });
      this.updatePerformance(); this.log('喷管配置已更新 · 膨胀比 ' + this.nozzle.expansion.toFixed(1) + ' / ' + this.nozzleMass.toFixed(1) + ' kg');
      return { ok: true, message: '喷管配置已更新，质量已计入干重' };
    }

    closeOxygen() {
      this.oxygenPump = false; this.oxygenFeedFlow = 0; this.oxygenFlow = 0; this.afterburnerPower = 0;
      this.commandedOxygenFlow = this.oxygenRipple = 0;
      if (Number.isFinite(this.flow)) this.updatePerformance();
    }

    setLoadout(fuel, oxygen = 0) {
      if (this.propellantLocked || this.controlsLocked || !this.canConfigure) return { ok: false, message: '储罐装载锁定：挑战开局后不可更改；沙盒需先停机' };
      const tank = loadout(this.propellant, fuel, oxygen);
      if (!tank.valid) return { ok: false, message: tank.message };
      this.fuel = this.tankCapacity = fuel; this.oxygen = this.initialOxygen = oxygen; this.oxygenTankInstalled = oxygen > 0;
      this.consumed = this.oxygenConsumed = 0; this.feedFlow = this.feedNominal = this.flow = 0; this.closeOxygen();
      this.oxygenInterlock = oxygen > 0 ? '液氧泵关闭' : '未安装液氧舱';
      this.updatePerformance(); this.log('储罐已装载 · ' + tank.usedVolume.toFixed(2) + ' / 150 m³');
      this.flight.operation('loadout', { fuel, oxygen });
      return { ok: true, message: '储罐配置已更新' };
    }

    injectFault(key) {
      if (!FAULTS[key] || this.faults.has(key)) return false;
      this.faults.add(key); this.acknowledged = false;
      this.flight.operation('injectFault', key);
      this.log(FAULTS[key].code + ' ' + FAULTS[key].title, 'danger');
      return true;
    }

    repairFault(key) {
      if (!this.faults.delete(key)) return false;
      this.flight.operation('repairFault', key);
      this.log(FAULTS[key].title + ' · 已修复');
      if (!this.faults.size) this.acknowledged = false;
      return true;
    }

    repairAll() {
      if (!this.faults.size) return false;
      this.faults.clear(); this.acknowledged = false; this.protectionTimer = 0;
      this.flight.operation('repairAll', true);
      this.log('全部故障已修复 · 检修完成');
      return true;
    }

    setSwitch(key, value, source = 'panel') {
      if (!['pump', 'oxygenPump', 'cooling', 'autoProtection'].includes(key) || this.controlsLocked) return;
      if (key === 'oxygenPump' && value && (!this.oxygenTankInstalled || this.propellant !== 'hydrogen' || this.usableOxygen <= 0)) return;
      this[key] = Boolean(value);
      this.flight.operation(key, this[key], source);
      const labels = { pump: '推进剂泵', oxygenPump: '液氧泵', cooling: '冷却回路', autoProtection: '自动保护' };
      this.log(labels[key] + (value ? ' · 开启' : ' · 关闭'), value ? 'info' : 'warning');
    }

    acknowledge(source = 'operator') {
      this.refreshAlarms();
      this.acknowledged = true;
      this.flight.operation('acknowledge', true, source);
      this.log('操作员确认告警 · 故障状态保留', 'warning');
    }

    get alarms() {
      return Object.keys(this.alarmLevels);
    }

    get alarmLevels() {
      const aliases = { reactor: 'tempHigh', pump: 'pumpOff', cooling: 'coolingOff', auto: 'protectionOff', oxygenPump: 'oxygenPumpOff' }, levels = {};
      for (const [id, , , , active, level = 0] of this.lamps) if (active && level > 0) {
        const key = aliases[id] || id; levels[key] = Math.max(levels[key] || 0, level);
      }
      if (this.fuelPercent < 2) levels.fuelResidual = this.fuelExhausted ? 3 : 2;
      if (this.oxygenTankInstalled && this.oxygenPercent < 2) levels.oxygenResidual = this.usableOxygen <= 0 ? 3 : 2;
      return levels;
    }

    refreshAlarms() {
      const active = new Map(Object.entries(this.alarmLevels));
      if ([...active].some(([id, level]) => level > (this.previousAlarms.get(id) || 0))) this.acknowledged = false;
      this.previousAlarms = active;
    }

    updatePerformance() {
      const gasTemp = Math.max(this.prop.inlet, this.coreTemperature - this.gasFilmDrop);
      const g = this.nozzle;
      let p = Math.max(100, this.pressure * 1e6 || 4e6);
      for (let i = 0; i < 3; i++) p = nozzle.chamberPressure(this.flow, thermo.atTemperature(gasTemp, Math.max(100, p), this.propellant === 'water' ? thermo.metadata.waterRatio : 0), g);
      this.pressure = Math.max(0, p / 1e6);
      const coolingReturn = this.cooling && this.pump && !this.faults.has('cooling') ? this.nozzleCoolingPower * thermo.metadata.model.regenerativeRecovery : 0;
      const coreH = this.coreGasEnthalpyAtTemperature === this.coreTemperature ? this.coreGasEnthalpy : null;
      const mixture = mixExhaust(this.flow, this.oxygenFlow, gasTemp, this.pressure, this.nozzleWallTemperature, this.scale, this.propellant, 'finite', coolingReturn, g, coreH);
      this.regenerativePower = mixture.regenerativePower;
      this.externalCoolingPower = this.nozzleCoolingPower - this.regenerativePower;
      this.afterburnerPower = this.propellant === 'hydrogen' ? mixture.chemicalPower : 0;
      this.thermoState = mixture; this.nozzleEnergy = mixture.energy; this.nozzleHeatLoad = mixture.heatLoad;
      const balance = mixture.energy, wallRate = this.nozzleHeatLoad - this.nozzleCoolingPower - this.nozzleRadiationPower;
      balance.cycleResidual = balance.nuclearTransported + balance.idealChemical - balance.feedConditioning - balance.kinetic
        - balance.exhaustThermal - balance.dissociation - wallRate - this.externalCoolingPower - this.nozzleRadiationPower;
      this.mixtureRatio = mixture.mixtureRatio; this.nozzleTemperature = this.totalFlow > 0 ? mixture.temperature : this.nozzleWallTemperature;
      this.products = { steam: mixture.steam, hydrogen: mixture.hydrogen, oxygen: mixture.oxygen, radicals: mixture.radicals,
        atomicHydrogen: mixture.atomicHydrogen, atomicOxygen: mixture.atomicOxygen, hydroxyl: mixture.hydroxyl, hydroperoxyl: mixture.hydroperoxyl, peroxide: mixture.peroxide };
      this.exhaustVelocity = mixture.velocity;
      this.jetVelocity = mixture.jetVelocity; this.pressureThrust = mixture.pressureThrust;
      this.kineticPower = mixture.kineticPower;
      this.thrust = this.totalFlow * this.exhaustVelocity / 1000;
      this.isp = this.exhaustVelocity / 9.80665;
    }

    tick(delta) {
      if (!Number.isFinite(delta) || delta <= 0) return;
      // Substeps preserve protection timing and thermal stability at 5× time.
      let remaining = Math.min(delta, 5);
      while (remaining > 1e-8) { const dt = Math.min(.05, remaining); this.step(dt); remaining -= dt; }
    }

    step(dt) {
      const beforeMass = this.mass;
      this.time += dt;
      if (this.mode === 'DAMAGED') { this.power = approach(this.power, 0, dt, .4); }
      else {
        const demand = this.isActive ? this.ratedPower * this.demand / 100 : this.decayPower;
        this.power = approach(this.power, demand, dt, this.mode === 'SCRAM' ? .25 : this.isActive ? 3.8 : 3.3);
      }
      this.decayPower *= Math.exp(-dt / 24);
      const valve = this.faults.has('valve') ? 28 : this.valve;
      const pumpEfficiency = this.fuelPumpEfficiency;
      const purgeFactor = this.isActive ? 1 : this.coreTemperature > 480 ? .35 : 0;
      const feedTarget = this.ratedFlow * valve / 100 * pumpEfficiency * purgeFactor;
      this.commandedFlow = feedTarget;
      this.feedNominal = approach(this.feedNominal, feedTarget, dt, 1.1);
      this.flowRipple = pumpRipple(feedTarget, this.time);
      this.feedFlow = Math.max(0, this.feedNominal + this.flowRipple);
      // No thrust or mass flow may be generated by propellant that does not exist.
      this.feedFlow = Math.min(this.feedFlow, this.usableFuel / dt);
      this.flow = this.feedFlow * (this.faults.has('leak') ? .57 : 1);
      const beforeCore = this.coreTemperature, heatCapacity = this.coreHeatCapacity;
      const gasTarget = thermo.atTemperature(Math.max(this.prop.inlet, beforeCore - this.gasFilmDrop), Math.max(100, this.pressure * 1e6 || 4e6), this.propellant === 'water' ? thermo.metadata.waterRatio : 0);
      const desiredHeat = Math.max(0, this.feedFlow * (gasTarget.h - thermo.metadata.feedEnthalpy[this.propellant]) / 1e6);
      const conductance = this.cooling && !this.faults.has('cooling') ? (this.isActive ? 1800 : 35000) : 80;
      this.coreCoolingPower = (conductance * this.scale * Math.max(0, beforeCore - 293) + .15 * this.scale * 5.670374419e-8 * Math.max(0, beforeCore ** 4 - 293 ** 4)) / 1e6;
      const available = Math.max(0, (beforeCore - this.prop.inlet) * heatCapacity / dt / 1e6 + this.power - this.coreCoolingPower);
      this.coreHeatToPropellant = Math.min(desiredHeat, available);
      this.coreGasEnthalpy = this.feedFlow > 0 ? thermo.metadata.feedEnthalpy[this.propellant] + this.coreHeatToPropellant * 1e6 / this.feedFlow : null;
      const nextCore = beforeCore + (this.power - this.coreHeatToPropellant - this.coreCoolingPower) * 1e6 * dt / heatCapacity;
      this.coreTemperature = clamp(nextCore, this.prop.inlet, 4900);
      this.coreGasEnthalpyAtTemperature = this.coreTemperature;
      this.coreStoredPower = (this.coreTemperature - beforeCore) * heatCapacity / dt / 1e6;
      this.coreOverflowPower = this.power - this.coreHeatToPropellant - this.coreCoolingPower - this.coreStoredPower;
      this.coreLeakHeat = this.coreHeatToPropellant * (this.faults.has('leak') ? .43 : 0);
      this.coolantTemperature = approach(this.coolantTemperature, 293 + (this.coreTemperature - 293) * ((!this.cooling || this.faults.has('cooling')) ? .22 : .075), dt, 6);
      const used = Math.min(this.fuel, this.feedFlow * dt);
      this.fuel = Math.max(0, this.fuel - used); this.consumed += used;
      // Oxygen never passes through the core. Injection is cut immediately on loss of hot H2 or a shutdown.
      const hotHydrogen = this.propellant === 'hydrogen' && this.isActive && this.flow > .1 && this.coreTemperature - 180 >= 700;
      this.oxygenInterlock = !this.oxygenTankInstalled ? '未安装液氧舱' : this.usableOxygen <= 0 ? '液氧达到残留量 · 纯核热模式' : !this.oxygenPump ? '液氧泵关闭'
        : !hotHydrogen ? '等待运行中的热氢流 ≥ 700 K' : this.oxygenValve <= 0 ? '液氧阀关闭' : '补燃运行';
      const oxygenTarget = hotHydrogen && this.oxygenPump && this.usableOxygen > 0 ? this.ratedOxygenFlow * this.oxygenValve / 100 * this.oxygenSupplyFactor : 0;
      this.commandedOxygenFlow = oxygenTarget;
      this.oxygenFeedFlow = oxygenTarget > 0 ? approach(this.oxygenFeedFlow, oxygenTarget, dt, .8) : 0;
      this.oxygenRipple = pumpRipple(oxygenTarget, this.time, 2.3);
      this.oxygenFlow = oxygenTarget > 0 ? Math.min(Math.max(0, this.oxygenFeedFlow + this.oxygenRipple), this.flow * 8, this.usableOxygen / dt) : 0;
      if (oxygenTarget > this.flow * 8 && oxygenTarget > 0) this.oxygenInterlock = '补燃运行 · O/H = 8 供氧限幅';
      const oxygenUsed = Math.min(this.oxygen, this.oxygenFlow * dt);
      this.oxygen = Math.max(0, this.oxygen - oxygenUsed); this.oxygenConsumed += oxygenUsed;
      const wall = this.nozzleWallTemperature;
      const coolantConductance = this.cooling && !this.faults.has('cooling') ? 16000 : 400;
      this.nozzleCoolingPower = coolantConductance * this.scale * Math.max(0, wall - this.coolantTemperature) / 1e6;
      const radiatingArea = nozzle.CONFIG.baseRadiatingFraction * this.nozzle.baseSurface + this.nozzle.extensionSurface;
      this.nozzleRadiationPower = .8 * 5.670374419e-8 * radiatingArea * Math.max(0, wall ** 4 - 293 ** 4) / 1e6;
      this.updatePerformance(); this.stepThrust = this.thrust; this.stepTotalFlow = this.totalFlow; this.totalImpulse += this.stepThrust * dt;
      this.wallEnergyRate = this.nozzleHeatLoad - this.nozzleCoolingPower - this.nozzleRadiationPower;
      this.nozzleWallTemperature += this.wallEnergyRate * 1e6 * dt / this.wallHeatCapacity;
      if (this.mode === 'STARTING' && Math.abs(this.power - this.ratedPower * this.demand / 100) < Math.max(2, this.ratedPower * .02)) {
        this.mode = 'RUNNING'; this.log('启动序列完成 · 进入稳定运行');
      }
      if (this.mode === 'SHUTDOWN' && this.power < 1 && this.coreTemperature < 500) {
        this.mode = 'STANDBY'; this.log('停机完成 · 系统待机');
      }
      const danger = this.thermoState.blocked ? '自动保护：喷管出口截面不足' : this.coreTemperature > 3250 ? '自动保护：堆芯温度超限' : this.pressure > 7.5 ? '自动保护：腔室压力超限' : this.nozzleWallTemperature > 1750 ? '自动保护：喷管壁温超限' : this.power > this.ratedPower * .12 && this.flow < this.ratedFlow * .09 ? '自动保护：推进剂流量不足' : this.fuelExhausted ? '自动保护：可用推进剂耗尽，保留残气' : null;
      this.protectionTimer = danger ? this.protectionTimer + dt : 0;
      if (this.autoProtection && this.isActive && this.protectionTimer > .75) this.scram(danger);
      if (this.coreTemperature > 3400) this.integrity = Math.max(0, this.integrity - (this.coreTemperature - 3400) / 75 * dt);
      if (this.integrity <= 0 && this.mode !== 'DAMAGED') {
        this.mode = 'DAMAGED'; this.decayPower = 0; this.acknowledged = false;
        this.closeOxygen(); this.updatePerformance();
        this.log('堆芯结构失效 · 试验终止，请重置', 'danger');
      }
      this.sampleTimer += dt;
      if (this.sampleTimer >= .5) { this.sampleTimer -= .5; this.recordSample(); }
      this.refreshAlarms();
      this.flight.step(this, beforeMass, dt);
    }

    recordSample() {
      this.history.push({ time: this.time, temperature: this.measuredTemperature, power: this.power, pressure: this.pressure, thrust: this.thrust, flow: this.totalFlow, isp: this.isp, oxygenFlow: this.oxygenFlow, afterburnerPower: this.afterburnerPower, nozzleWallTemperature: this.nozzleWallTemperature, nozzleHeatLoad: this.nozzleHeatLoad, dissociationPower: this.dissociationPower });
      if (this.history.length > 240) this.history.shift();
    }

    get lamps() {
      const temperature = grade(this.measuredTemperature, [3050, 3150, 3250]);
      const pressure = grade(this.pressure, [6.5, 7, 7.5]);
      const nozzle = Math.max(this.thermoState.blocked ? 3 : 0, grade(this.nozzleTemperature, [4000, 4500, 5000]), grade(this.nozzleWallTemperature, [1250, 1450, 1650]));
      const needsFeed = this.isActive, needsCooling = this.isActive || this.coreTemperature > 650 || this.nozzleWallTemperature > 650;
      const needsOxygen = this.isActive && this.oxygenTankInstalled && this.oxygenValve > 0 && this.usableOxygen > 0;
      const pumpFault = this.faults.has('pump') ? (this.feedFlow / this.ratedFlow < .25 ? 3 : 2) : 0;
      const lineFault = this.faults.has('leak') ? 3 : this.faults.has('valve') ? 1 : 0;
      const thermalFault = this.faults.has('cooling') ? 3 : this.faults.has('sensor') ? 1 : 0;
      return [
        ['reactor', '反应堆', 'REACTOR', warningColor(temperature), this.isActive && this.power > 10, this.isActive ? temperature : 0],
        ['pump', '供液泵', 'FEED PUMP', needsFeed && !this.pump ? 'amber' : pumpFault ? warningColor(pumpFault) : 'green', this.pump || needsFeed, needsFeed && !this.pump ? 1 : 0],
        ['cooling', '冷却回路', 'COOLANT', needsCooling && !this.cooling ? 'amber' : this.faults.has('cooling') ? 'red' : 'green', this.cooling || needsCooling, needsCooling && !this.cooling ? 1 : 0],
        ['telemetry', '遥测在线', 'TELEMETRY', 'green', true],
        ['hydrogen', '液氢模式', 'LH2 CYCLE', 'blue', this.propellant === 'hydrogen'],
        ['water', '水汽模式', 'H2O CYCLE', 'blue', this.propellant === 'water'],
        ['auto', '自动保护', 'AUTO TRIP', this.isActive && !this.autoProtection ? 'amber' : 'blue', this.autoProtection || this.isActive, this.isActive && !this.autoProtection ? 1 : 0],
        ['ready', '启动就绪', 'SYS READY', 'blue', this.integrity > 0 && !this.faults.size && this.pump && this.cooling && !this.fuelExhausted],
        ['tempHigh', '温度过高', 'TEMP HIGH', warningColor(temperature), temperature > 0, temperature],
        ['pressureHigh', '压力过高', 'PRES HIGH', warningColor(pressure), pressure > 0, pressure],
        ['fuelLow', '储量不足', 'TANK LOW', this.fuelPercent < 2 ? 'red' : this.fuelPercent < 5 ? 'orange' : 'amber', this.fuelPercent < 20, this.fuelPercent < 2 ? 3 : this.fuelPercent < 5 ? 2 : this.fuelPercent < 20 ? 1 : 0],
        ['decay', '余热冷却', 'DECAY HEAT', 'amber', !this.isActive && this.coreTemperature > 500],
        ['pumpFault', '泵组状态', 'PUMP HEALTH', warningColor(pumpFault), true, pumpFault],
        ['leakFault', '管路状态', 'LINE HEALTH', warningColor(lineFault), true, lineFault],
        ['thermalFault', '热控状态', 'THERM HEALTH', warningColor(thermalFault), true, thermalFault],
        ['scram', '紧急停堆', 'SCRAM', 'red', this.mode === 'SCRAM' || this.mode === 'DAMAGED', this.mode === 'SCRAM' || this.mode === 'DAMAGED' ? 3 : 0],
        ['oxygenPump', '液氧泵', 'LOX PUMP', needsOxygen && !this.oxygenPump ? 'amber' : 'blue', this.oxygenPump || needsOxygen, needsOxygen && !this.oxygenPump ? 1 : 0],
        ['afterburner', '液氧补燃', 'AFTERBURN', 'green', this.oxygenFlow > 0],
        ['oxygenLow', '液氧不足', 'LOX LOW', this.oxygenPercent < 2 ? 'red' : 'amber', this.oxygenTankInstalled && this.oxygenPercent < 10, this.oxygenTankInstalled && this.oxygenPercent < 10 ? this.oxygenPercent < 2 ? 3 : 1 : 0],
        ['nozzleHot', '喷管热负荷', 'NOZZLE HEAT', warningColor(nozzle), nozzle > 0, nozzle]
      ];
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { NTRSimulation, PROPELLANTS, FAULTS, TELEMETRY_LIMITS };
  else { root.NTRSimulation = NTRSimulation; root.NTR_PROPELLANTS = PROPELLANTS; root.NTR_FAULTS = FAULTS; root.NTR_TELEMETRY_LIMITS = TELEMETRY_LIMITS; }
})(typeof window !== 'undefined' ? window : globalThis);
