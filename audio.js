/* Procedural cockpit / structure-borne listening effects. No media downloads.
   Native Web Audio nodes do the DSP; the UI only sends control-rate updates. */
(function (root) {
  'use strict';
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const ALARMS = Object.freeze({
    scram: { label: '紧急停堆', priority: 100, tones: [960, 640, 1120], type: 'sawtooth', length: .23, gap: .06, period: .8 },
    pumpFault: { label: '泵组故障', priority: 90, tones: [230, 460, 230], type: 'square', length: .11, gap: .07, period: 2 },
    thermalFault: { label: '热控故障', priority: 85, tones: [520, 390], type: 'triangle', length: .23, gap: .08, period: 2.1 },
    leakFault: { label: '管路故障', priority: 80, tones: [940, 650, 940], type: 'sine', length: .1, gap: .09, period: 2.2 },
    tempHigh: { label: '堆芯高温', priority: 75, tones: [880, 660], type: 'triangle', length: .18, gap: .09, period: 2 },
    pressureHigh: { label: '压力过高', priority: 74, tones: [980, 1120, 1260], type: 'square', length: .09, gap: .08, period: 2.2 },
    nozzleHot: { label: '喷管高温', priority: 70, tones: [1180, 980, 1180], type: 'triangle', length: .1, gap: .06, period: 2.4 },
    fuelResidual: { label: '主剂残气供液', priority: 65, tones: [400, 300, 220], type: 'triangle', length: .12, gap: .1, period: 2.8 },
    oxygenResidual: { label: '液氧残气供液', priority: 64, tones: [750, 550, 350], type: 'sine', length: .12, gap: .1, period: 2.8 },
    fuelLow: { label: '主推进剂不足', priority: 40, tones: [440, 440], type: 'sine', length: .12, gap: .18, period: 4 },
    oxygenLow: { label: '液氧不足', priority: 39, tones: [600, 780], type: 'sine', length: .12, gap: .18, period: 4 },
    pumpOff: { label: '运行中主泵关闭', priority: 69, tones: [360, 540, 360], type: 'triangle', length: .12, gap: .09, period: 1.5 },
    coolingOff: { label: '所需冷却关闭', priority: 68, tones: [720, 540, 720], type: 'triangle', length: .14, gap: .07, period: 1.4 },
    protectionOff: { label: '运行中保护关闭', priority: 45, tones: [560, 840], type: 'sine', length: .1, gap: .1, period: 1.8 },
    oxygenPumpOff: { label: '注氧指令下氧泵关闭', priority: 44, tones: [660, 440, 660], type: 'sine', length: .1, gap: .08, period: 1.8 }
  });
  function soundState(sim, silent = false) {
    const flow = clamp(sim.flow / Math.max(1, sim.ratedFlow));
    const oxygen = clamp(sim.oxygenFlow / Math.max(1, sim.ratedOxygenFlow));
    const power = clamp(sim.power / Math.max(1, sim.ratedPower));
    const mode = sim.propellant === 'water' ? 'water' : sim.oxygenFlow > .01 ? 'lantr' : 'hydrogen';
    const levels = sim.alarmLevels;
    const alarms = Object.keys(levels).filter(id => ALARMS[id] && !(id === 'fuelLow' && sim.fuelSupplyFactor < 1)
      && !(id === 'oxygenLow' && sim.oxygenSupplyFactor < 1)).sort((a, b) => levels[b] - levels[a] || ALARMS[b].priority - ALARMS[a].priority);
    return { mode, flow: silent ? 0 : flow, oxygen: silent ? 0 : oxygen, power: silent ? 0 : power,
      pump: !silent && sim.pump ? flow : 0, silent, levels, acknowledged: sim.acknowledged, alarms: silent ? [] : alarms };
  }
  class NTRSound {
    constructor({ context = null, offline = false } = {}) {
      this.context = context; this.offline = offline; this.enabled = false; this.volume = .35;
      this.graph = null; this.timer = null; this.voices = new Set(); this.parameters = new Map();
      this.state = null; this.nextAlarm = 0; this.alarmIndex = 0; this.alarmSignature = ''; this.lastAlarm = null;
      this.lastChord = [];
    }
    get status() { return !this.enabled ? '音效关闭' : this.state?.silent ? '监听暂停' : this.state?.flow > .001
      ? { hydrogen: '液氢喷流 · 混响', lantr: '液氧补燃 · 混响', water: '水汽喷流' }[this.state.mode] : '仪表底噪 · 待机'; }
    async enable() {
      if (!this.context) {
        const Audio = root.AudioContext || root.webkitAudioContext;
        if (!Audio) throw new Error('当前浏览器不支持 Web Audio');
        this.context = new Audio({ latencyHint: 'interactive' });
      }
      if (!this.graph) this.buildGraph();
      if (!this.offline) await this.context.resume();
      this.enabled = true; this.setVolume(this.volume);
      if (this.state) this.applyState();
      if (!this.offline && !this.timer) this.timer = setInterval(() => this.schedule(), 125);
    }
    disable() {
      this.enabled = false; this.stopAlarms(); clearInterval(this.timer); this.timer = null;
      if (this.graph) this.graph.master.gain.setTargetAtTime(0, this.context.currentTime, .015);
      if (this.context && !this.offline) this.context.suspend().catch(() => {});
    }
    setVolume(value) {
      this.volume = clamp(value);
      if (this.graph) this.graph.master.gain.setTargetAtTime(this.enabled ? this.volume * .8 : 0, this.context.currentTime, .025);
    }
    buildGraph() {
      const ctx = this.context, gain = value => { const node = ctx.createGain(); node.gain.value = value; return node; };
      const mix = gain(1), master = gain(0), limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12; limiter.knee.value = 12; limiter.ratio.value = 5; limiter.attack.value = .006; limiter.release.value = .18;
      mix.connect(limiter); limiter.connect(master); master.connect(ctx.destination);
      const engine = gain(1), dry = gain(.8), wet = gain(.25), reverb = ctx.createConvolver();
      const impulse = ctx.createBuffer(2, Math.round(ctx.sampleRate * .75), ctx.sampleRate);
      let seed = 1963;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
      for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < data.length; i++) data[i] = random() * (1 - i / data.length) ** 3;
      }
      reverb.buffer = impulse; engine.connect(dry); dry.connect(mix); engine.connect(reverb); reverb.connect(wet); wet.connect(mix);
      const noise = ctx.createBufferSource(), noiseBuffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 2), ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = random();
      noise.buffer = noiseBuffer; noise.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1500; filter.Q.value = .6;
      const hiss = gain(0); noise.connect(filter); filter.connect(hiss); hiss.connect(engine);
      const burnFilter = ctx.createBiquadFilter(); burnFilter.type = 'lowpass'; burnFilter.frequency.value = 380;
      const burn = gain(0); noise.connect(burnFilter); burnFilter.connect(burn); burn.connect(engine);
      const oscillator = (type, frequency, destination) => {
        const node = ctx.createOscillator(); node.type = type; node.frequency.value = frequency; node.connect(destination); node.start(); return node;
      };
      const rumble = gain(0), pump = gain(0), instrument = gain(0), cabin = gain(.007);
      rumble.connect(engine); pump.connect(mix); instrument.connect(mix); cabin.connect(instrument);
      const core = oscillator('triangle', 52, rumble), pumpTone = oscillator('sine', 190, pump);
      oscillator('sine', 60, cabin); const overtone = gain(.002); overtone.connect(instrument); oscillator('sine', 420, overtone);
      const alarm = gain(0); alarm.connect(mix);
      noise.start();
      this.graph = { mix, master, engine, dry, wet, filter, hiss, burn, rumble, pump, instrument, core, pumpTone, alarm };
    }
    target(parameter, value, tau = .12) {
      if (Math.abs((this.parameters.get(parameter) ?? Infinity) - value) < .0001) return;
      parameter.setTargetAtTime(value, this.context.currentTime, tau); this.parameters.set(parameter, value);
    }
    update(sim, silent = false) {
      this.state = soundState(sim, silent);
      if (this.enabled) this.applyState();
    }
    applyState() {
      const state = this.state, g = this.graph;
      if (!state || !g) return;
      const water = state.mode === 'water', lantr = state.mode === 'lantr';
      this.target(g.instrument.gain, state.silent ? 0 : 1, .06);
      this.target(g.hiss.gain, state.flow * (water ? .24 : .15));
      this.target(g.filter.frequency, water ? 420 + state.flow * 650 : 850 + state.power * 2100);
      this.target(g.rumble.gain, state.flow * (water ? .12 : .07) + state.oxygen * .13);
      this.target(g.core.frequency, (water ? 38 : 55) + state.flow * (water ? 36 : 80) + state.oxygen * 25);
      this.target(g.burn.gain, state.oxygen * .48);
      this.target(g.pump.gain, state.pump * .018);
      this.target(g.pumpTone.frequency, 150 + state.pump * 310);
      this.target(g.wet.gain, water ? .055 : lantr ? .42 : .26);
      const signature = state.alarms.map(id => id + ':' + state.levels[id]).join('|');
      if (state.acknowledged || state.silent || !signature) this.stopAlarms();
      else if (signature !== this.alarmSignature) { this.stopAlarms(); this.nextAlarm = 0; this.alarmIndex = 0; }
      this.alarmSignature = signature;
      this.schedule();
    }
    stopAlarms() {
      if (!this.graph) return;
      const now = this.context.currentTime;
      this.graph.alarm.gain.cancelScheduledValues(now); this.graph.alarm.gain.setTargetAtTime(0, now, .008);
      for (const node of this.voices) { try { node.stop(now + .025); } catch { /* already ended */ } }
      this.voices.clear(); this.lastAlarm = null; this.lastChord = [];
    }
    schedule() {
      if (!this.enabled || !this.state || this.state.silent || this.state.acknowledged || !this.state.alarms.length) return;
      const now = this.context.currentTime;
      if (now < this.nextAlarm) return;
      const alarms = this.state.alarms;
      const keys = alarms.length <= 4 ? alarms : [alarms[0], alarms[1], alarms[2 + this.alarmIndex++ % (alarms.length - 2)], alarms[2 + this.alarmIndex % (alarms.length - 2)]];
      const urgency = Math.max(...keys.map(id => this.state.levels[id]));
      this.graph.alarm.gain.setTargetAtTime(.2 / Math.sqrt(keys.length), now, .008);
      this.lastChord = keys;
      keys.forEach((key, i) => this.playAlarm(key, [-.75, .75, -.25, .25][i], this.state.levels[key]));
      this.nextAlarm = now + (urgency >= 3 ? .78 : urgency === 2 ? 1.05 : 1.6);
    }
    playAlarm(key, pan = 0, level = 1) {
      if (!this.graph || !ALARMS[key]) return;
      const profile = ALARMS[key], now = this.context.currentTime;
      this.lastAlarm = key;
      const pace = level >= 3 ? .65 : level === 2 ? .8 : .95;
      profile.tones.forEach((frequency, index) => {
        const start = now + .012 + index * (profile.length + profile.gap) * pace, end = start + profile.length * pace;
        const oscillator = this.context.createOscillator(), envelope = this.context.createGain();
        const channel = this.context.createStereoPanner(); channel.pan.value = pan;
        oscillator.type = profile.type; oscillator.frequency.value = frequency * (1 + (level - 1) * .06);
        envelope.gain.setValueAtTime(0, start); envelope.gain.linearRampToValueAtTime(.65, start + .008);
        envelope.gain.setValueAtTime(.65, end - .018); envelope.gain.linearRampToValueAtTime(0, end);
        oscillator.connect(envelope); envelope.connect(channel); channel.connect(this.graph.alarm); this.voices.add(oscillator);
        oscillator.onended = () => { this.voices.delete(oscillator); oscillator.disconnect(); envelope.disconnect(); channel.disconnect(); };
        oscillator.start(start); oscillator.stop(end + .01);
      });
    }
    click(ack = false) {
      if (!this.enabled || !this.graph || this.state?.silent) return;
      const now = this.context.currentTime, oscillator = this.context.createOscillator(), envelope = this.context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(ack ? 1040 : 1450, now); oscillator.frequency.exponentialRampToValueAtTime(ack ? 720 : 820, now + .035);
      envelope.gain.setValueAtTime(.024, now); envelope.gain.exponentialRampToValueAtTime(.0001, now + .05);
      oscillator.connect(envelope); envelope.connect(this.graph.mix); oscillator.start(); oscillator.stop(now + .06);
      oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    }
  }
  const api = { NTRSound, ALARMS, soundState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.NTRSound = NTRSound; root.NTR_AUDIO = api; }
})(typeof window !== 'undefined' ? window : globalThis);
