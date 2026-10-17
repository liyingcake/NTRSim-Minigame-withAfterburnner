/* Flight report UI. Large tables are rendered only on demand, never per frame. */
(function (root) {
  'use strict';
  const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, p = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p }) : '—';
  const names = { language: '界面语言设置', tooltipDelay: '工具提示延迟设置', pressureCheck: '超压可靠性判定', nozzleConfigure: '喷管几何配置', missionSetup: '任务开局设定', demand: '反应堆功率指令 / %', valve: '主推进剂阀指令 / %', oxygenValve: '液氧阀指令 / %', pump: '主推进剂泵', oxygenPump: '液氧泵', cooling: '冷却回路', autoProtection: '自动保护', start: '启动', shutdown: '正常停机', scram: '紧急停堆', acknowledge: '确认告警', configure: '引擎配置', loadout: '储罐加注', settle: '结算', event: '系统事件', injectFault: '注入故障', repairFault: '修复故障', repairAll: '全部修复', pause: '暂停', speed: '模拟倍率', reset: '重置', page: 'MFD 页面', volume: '音量', binding: '快捷键设置' };
  const value = v => typeof v === 'boolean' ? v ? '开启' : '关闭' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  class FlightView {
    constructor({ archive, snapshot, notify }) {
      this.archive = archive; this.snapshot = snapshot; this.notify = notify; this.report = null; this.tab = 'first60'; this.$ = id => document.getElementById(id);
      this.$('flightRecordTabs').addEventListener('click', e => { const button = e.target.closest('[data-flight-tab]'); if (button) { this.tab = button.dataset.flightTab; this.table(); } });
      this.$('flightRefreshButton').addEventListener('click', () => { this.display(this.snapshot()); this.history(); });
      this.$('flightSaveButton').addEventListener('click', async () => { const saved = await archive.save(this.report); this.status(saved); await this.history(); });
      this.$('flightRecordSelect').addEventListener('change', async e => { const report = e.target.value === 'current' ? this.snapshot() : await archive.get(e.target.value); if (report) this.display(report); });
      this.$('flightJSONButton').addEventListener('click', () => this.download(JSON.stringify(this.report, null, 2), 'json', 'application/json'));
      this.$('flightCSVButton').addEventListener('click', () => this.download(root.NTR_ARCHIVE.telemetryCSV(this.report), 'telemetry.csv', 'text/csv;charset=utf-8'));
      this.$('flightCommandsButton').addEventListener('click', () => {
        const cell = v => '"' + String(v).replaceAll('"', '""') + '"';
        const rows = this.report.operations.map(o => [o.time, o.wallTime, o.phase, o.action, value(o.value), o.source, o.detail].map(cell).join(','));
        this.download('\uFEFFtime_s,wallTime_ms,phase,action,value,source,detail\r\n' + rows.join('\r\n'), 'commands.csv', 'text/csv;charset=utf-8');
      });
    }
    async open(report) {
      this.display(report || this.snapshot());
      document.querySelectorAll('dialog[open]').forEach(d => d.close()); this.$('flightRecordDialog').showModal();
      await this.history();
    }
    async history() {
      const records = await this.archive.list();
      this.$('flightRecordSelect').innerHTML = '<option value="current">当前试飞 / 实时快照</option>' + records.map(r => '<option value="' + escape(r.id) + '">' + escape(new Date(r.createdAt).toLocaleString('zh-CN') + ' · ' + (r.version || '') + ' · ' + r.initial.engineModel + ' · Δv ' + fmt(r.stats.deltaV) + ' m/s') + '</option>').join('');
      if (records.some(r => r.id === this.report?.id && r.createdAt === this.report.createdAt)) this.$('flightRecordSelect').value = this.report.id;
      this.status(this.archive.persistent);
    }
    status(saved) { this.$('flightArchiveStatus').textContent = saved ? '本地档案可用 · 挑战结算自动保存；沙盒可保存快照或下载 JSON。' : '记录暂存于本次会话；可下载 JSON 保存完整档案。'; }
    display(report) {
      this.report = report;
      const s = report.stats, i = report.initial, f = report.final;
      this.$('flightRecordHeading').textContent = i.engineModel + ' / ' + (report.version || '') + (report.score ? ' · ' + fmt(report.score.total, 0) + ' PTS' : ' · 试飞快照');
      this.$('flightRecordSubtitle').textContent = 'T+ ' + fmt(s.elapsed) + ' s · ' + (report.reason || '当前记录') + ' · ' + report.id;
      const metric = ([label, text]) => '<div><span>' + escape(label) + '</span><strong>' + escape(text) + '</strong></div>';
      this.$('flightRecordHero').innerHTML = [['累计速度增量', fmt(s.deltaV) + ' m/s'], ['峰值推力', fmt(s.peakThrust) + ' kN'], ['总冲量', fmt(s.totalImpulse / 1000) + ' MN·s']].map(metric).join('');
      this.$('flightRecordMetrics').innerHTML = [['平均推力 / 全程', fmt(s.meanThrust) + ' kN'], ['平均推力 / 有推力段', fmt(s.burnMeanThrust) + ' kN'], ['有推力时长', fmt(s.burnTime) + ' s'], ['累计有效比冲', fmt(s.effectiveIsp) + ' s'], ['峰值加速度', fmt(s.peakAcceleration, 3) + ' m/s²'], ['峰值船体 / 引擎推重比', fmt(s.peakShipThrustWeight, 3) + ' / ' + fmt(s.peakEngineThrustWeight, 3)], ['飞行距离', fmt(s.distance / 1000) + ' km'], ['剩余主剂 / 液氧', fmt(f.mainPropellant) + ' / ' + fmt(f.oxygen) + ' kg'], ['基础 / 引擎 / 货物', fmt(f.baseDryMass, 0) + ' / ' + fmt(f.engineMass) + ' / ' + fmt(f.payload, 0) + ' kg'], ['干重 / 当前总质量', fmt(f.dryMass) + ' / ' + fmt(f.mass) + ' kg'], ['点火时总质量', fmt(i.mass) + ' kg'], ['当前推力 / 加速度', fmt(s.finalThrust) + ' kN / ' + fmt(s.finalAcceleration, 3) + ' m/s²']].map(metric).join('');
      this.$('flightRecordConfiguration').innerHTML = [['引擎 / 直径 / 额定功率', i.engineModel + ' / ' + fmt(i.diameter) + ' m / ' + fmt(i.ratedPower) + ' MW'], ['主剂 / 初装主剂 / 初装液氧', (i.propellant === 'hydrogen' ? 'LH₂' : 'H₂O') + ' / ' + fmt(i.mainTankInitial) + ' / ' + fmt(i.oxygenTankInitial) + ' kg'], ['点火功率 / 主阀 / 氧阀', fmt(i.demand) + ' / ' + fmt(i.mainValve) + ' / ' + fmt(i.oxygenValve) + '%'], ['主泵 / 氧泵 / 冷却 / 保护', [i.mainPump, i.oxygenPump, i.cooling, i.autoProtection].map(value).join(' / ')], ['引擎基体 / 喷管', fmt(i.baseEngineMass) + ' / ' + fmt(i.nozzleMass) + ' kg'], ['喉部 / 出口面积', fmt(i.nozzle?.throatArea, 5) + ' / ' + fmt(i.nozzle?.exitArea, 3) + ' m²'], ['基础 / 总膨胀比', fmt(i.nozzle?.expansionRatio, 1) + ' / ' + fmt(i.nozzle?.expansion, 1)], ['半角 / 延长段 / 总长', fmt(i.nozzle?.halfAngle, 0) + '° / ' + fmt(i.nozzle?.extension) + ' / ' + fmt(i.nozzle?.length) + ' m'], ['点火时容积 / 当前容积', fmt(i.tankVolume) + ' / ' + fmt(f.tankVolume) + ' m³'], ['超压判定 / 损伤事件', fmt(f.pressureChecks, 0) + ' / ' + fmt(f.pressureFailures, 0)], ['结算部件损伤', Object.entries(f.faultDamage || {}).map(([k, d]) => ({ pump: '主泵', oxygenPump: '氧泵', cooling: '冷却', leak: '管路', valve: '主阀', sensor: '温度传感器' }[k] || k) + ' ' + fmt(d * 100) + '%').join(' / ') || '无'], ['记录时间窗', '0–60 s + 末尾 120 s · 2 Hz · 含快照时刻']].map(metric).join('');
      this.table();
    }
    table() {
      if (!this.report) return;
      for (const b of this.$('flightRecordTabs').querySelectorAll('[data-flight-tab]')) { const active = b.dataset.flightTab === this.tab; b.classList.toggle('selected', active); b.setAttribute('aria-selected', active); }
      const r = this.report;
      if (this.tab === 'operations') {
        this.$('flightRecordChart').innerHTML = '';
        this.$('flightWindowSummary').textContent = r.operations.length + ' 条指令与系统事件' + (r.droppedOperations ? ' · 较早的 ' + r.droppedOperations + ' 条已移除' : '');
        this.$('flightRecordTable').innerHTML = '<table><thead><tr><th>T+ / s</th><th>阶段</th><th>操作</th><th>指令 / 结果</th><th>来源</th></tr></thead><tbody>' + r.operations.map(o => '<tr><td>' + fmt(o.time) + '</td><td>' + (o.phase === 'PREPARING' ? '准备' : '飞行') + '</td><td>' + escape(names[o.action] || o.action) + '</td><td class="command-value">' + escape(value(o.value)) + '</td><td>' + escape(o.source) + '</td></tr>').join('') + '</tbody></table>'; return;
      }
      const rows = r.telemetry[this.tab];
      this.$('flightWindowSummary').textContent = (rows.length ? fmt(rows[0][0]) + '–' + fmt(rows.at(-1)[0]) + ' s · ' : '') + rows.length + ' 个样本 · CSV 包含全部 ' + r.telemetry.columns.length + ' 个通道';
      this.$('flightRecordChart').innerHTML = this.chart(rows);
      const columns = [[0, 'T+ s'], [1, '推力 kN'], [2, '功率 MW'], [3, '压力 MPa'], [4, '堆芯 K'], [7, '主剂 kg/s'], [8, '液氧 kg/s'], [9, '比冲 s'], [11, '加速度 m/s²'], [12, 'Δv m/s'], [16, '功率 %'], [17, '主阀 %'], [18, '氧阀 %']];
      for (const [key, label] of [['hMassFraction', '主腔 H 比例'], ['mixHMassFraction', '混合站 H 比例'], ['exitHMassFraction', '出口 H 比例'], ['exitPressure_Pa', '出口 Pa']]) { const index = r.telemetry.columns.indexOf(key); if (index >= 0) columns.push([index, label]); }
      this.$('flightRecordTable').innerHTML = '<table><thead><tr>' + columns.map(c => '<th>' + c[1] + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + columns.map(([index]) => '<td>' + (r.telemetry.columns[index].includes('MassFraction') && row[index] > 0 && row[index] < .0001 ? row[index].toExponential(2) : fmt(row[index], r.telemetry.columns[index].includes('MassFraction') ? 5 : index === 11 ? 3 : 2)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }
    chart(rows) {
      if (!rows.length) return '<p>等待首次点火后的遥测记录。</p>';
      const start = rows[0][0], end = rows.at(-1)[0], max = Math.max(1, ...rows.map(r => r[1]));
      const curve = rows.map(r => (40 + (r[0] - start) / Math.max(.5, end - start) * 790).toFixed(2) + ',' + (120 - r[1] / max * 88).toFixed(2)).join(' ');
      return '<svg viewBox="0 0 860 150" role="img" aria-label="记录时间窗内的推力曲线"><path d="M40 25V120H830M40 76H830M40 32H830" stroke="#5a6f4c" fill="none" stroke-width=".6"/><polyline points="' + curve + '" stroke="#c4d69d" fill="none" stroke-width="1.7"/><g fill="#b4c29d" font-family="Consolas" font-size="10"><text x="40" y="15">THRUST / kN</text><text x="5" y="36">' + fmt(max, 0) + '</text><text x="20" y="123">0</text><text x="40" y="140">' + fmt(start) + ' s</text><text x="830" y="140" text-anchor="end">' + fmt(end) + ' s</text></g></svg>';
    }
    download(content, extension, type) {
      const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a');
      link.href = url; link.download = 'NERVA-' + this.report.id + '.' + extension; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  root.NTRFlightView = FlightView;
})(window);
