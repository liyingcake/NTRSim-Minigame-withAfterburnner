/* Optional local diagnostics: open ?profile=1. No network or permanent telemetry. */
(function (root) {
  'use strict';
  const summarize = values => {
    if (!values.length) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0, total: 0 };
    const sorted = [...values].sort((a, b) => a - b), total = values.reduce((sum, value) => sum + value, 0);
    return { count: values.length, mean: total / values.length, p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.floor((sorted.length - 1) * .95)], max: sorted.at(-1), total };
  };
  function create() {
    const enabled = new URLSearchParams(location.search).has('profile');
    const api = { enabled, recording: false, result: null, record() {} };
    if (!enabled) return api;
    const diagnostic = new URLSearchParams(location.search).get('diagnostic') || 'normal';
    if (diagnostic === 'flat-background') document.body.style.backgroundImage = 'none';
    if (diagnostic === 'hide-mfd') document.getElementById('mfdCanvas').style.visibility = 'hidden';
    let frames = [], start = 0, finish = 0, mutationCount = 0, timer, longTasks = [], longFrames = [];
    const panel = document.createElement('aside'); panel.id = 'performancePanel';
    panel.innerHTML = '<div><b>性能采样 / 8 秒</b><button id="profileStart">开始采样</button><button id="profileClose" aria-label="关闭性能面板">×</button></div><span id="profileStatus">记录帧间隔、物理、DOM 与 MFD 开销</span><pre id="profileResult" hidden></pre>';
    document.body.append(panel);
    const output = document.getElementById('profileResult'), status = document.getElementById('profileStatus');
    const observers = [];
    if (typeof PerformanceObserver !== 'undefined') {
      for (const type of ['longtask', 'long-animation-frame']) {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
        const observer = new PerformanceObserver(list => {
          if (!api.recording) return;
          for (const entry of list.getEntries()) {
            if (entry.startTime < start || entry.startTime >= finish) continue;
            if (type === 'longtask') longTasks.push(entry.duration);
            else longFrames.push({ duration: entry.duration, blockingDuration: entry.blockingDuration,
              styleLayout: entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0 });
          }
        });
        observer.observe({ type, buffered: false }); observers.push(observer);
      }
    }
    const mutations = new MutationObserver(records => {
      if (api.recording) mutationCount += records.filter(record => !panel.contains(record.target)).length;
    });
    function done() {
      if (!api.recording) return;
      mutations.disconnect(); api.recording = false; clearTimeout(timer);
      const elapsed = Math.max(.001, (performance.now() - start) / 1000);
      const intervals = frames.map(frame => frame.interval).filter(value => value > 0);
      const intervalStats = summarize(intervals), budget = intervalStats.p50 || 1000 / 60;
      const metadata = root.nerva;
      const bounds = document.getElementById('mfdCanvas').getBoundingClientRect();
      api.result = {
        version: root.NTR_RELEASE.version, diagnostic, seconds: elapsed, page: metadata?.page, speed: metadata?.speed,
        mission: metadata?.mission?.type || 'sandbox', fps: frames.length / elapsed,
        viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency,
        scroll: [scrollX, scrollY], canvas: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        mfdFps: frames.filter(frame => frame.mfd >= 0).length / elapsed,
        interval: intervalStats, over33ms: intervals.filter(value => value > 33.34).length,
        missedBudget: intervals.filter(value => value > budget * 1.5).length,
        physics: summarize(frames.map(frame => frame.physics)),
        dom: summarize(frames.filter(frame => frame.dom >= 0).map(frame => frame.dom)),
        mfd: summarize(frames.filter(frame => frame.mfd >= 0).map(frame => frame.mfd)),
        js: summarize(frames.map(frame => frame.js)), mutationCount,
        longTasks: summarize(longTasks), longAnimationFrames: longFrames,
        supportedObservers: typeof PerformanceObserver === 'undefined' ? [] : PerformanceObserver.supportedEntryTypes.filter(type => ['longtask', 'long-animation-frame'].includes(type))
      };
      output.textContent = JSON.stringify(api.result, null, 2); output.hidden = false;
      status.textContent = `完成：RAF ${api.result.fps.toFixed(1)} / MFD ${api.result.mfdFps.toFixed(1)} FPS · JS p95 ${api.result.js.p95.toFixed(2)} ms`;
      document.getElementById('profileStart').disabled = false;
    }
    document.getElementById('profileStart').addEventListener('click', () => {
      frames = []; mutationCount = 0; longTasks = []; longFrames = []; api.result = null;
      start = performance.now(); finish = start + 8000; api.recording = true;
      output.hidden = true; status.textContent = '采样中：保持页面、速度及视口不变';
      document.getElementById('profileStart').disabled = true;
      mutations.observe(document.body, { attributes: true, characterData: true, childList: true, subtree: true });
      timer = setTimeout(done, 8000);
    });
    document.getElementById('profileClose').addEventListener('click', () => { done(); panel.hidden = true; });
    api.record = frame => { if (api.recording) frames.push(frame); };
    return api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { summarize };
  else root.NTRPerformance = { create, summarize };
})(typeof window !== 'undefined' ? window : globalThis);
