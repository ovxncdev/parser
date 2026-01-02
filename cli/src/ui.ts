import blessed from 'blessed';
import contrib from 'blessed-contrib';
import {
  DEFAULT_STATS,
  DEFAULT_PROGRESS,
  DEFAULT_PROXY_INFO,
} from './types.js';
import type {
  StatsData,
  ProgressData,
  ProxyInfo,
  ActivityEntry,
  UIState,
} from './types.js';
import { formatDuration, formatNumber } from './output.js';

export class TerminalUI {
  private screen: blessed.Widgets.Screen;
  private grid: any;
  private progressBar: any;
  private statsLcd: any;
  private sparkline: any;
  private logBox: any;
  private proxyDonut: any;
  private statsTable: any;
  private controlsBox: any;
  private state: UIState;
  private throughputHistory: number[] = [];
  private readonly MAX_HISTORY = 60;
  private onPause?: () => void;
  private onResume?: () => void;
  private onQuit?: () => void;
  private onSpeedUp?: () => void;
  private onSpeedDown?: () => void;

  constructor() {
    this.state = {
      isRunning: false,
      isPaused: false,
      stats: { ...DEFAULT_STATS },
      progress: { ...DEFAULT_PROGRESS },
      proxyInfo: { ...DEFAULT_PROXY_INFO },
      recentActivity: [],
      throughputHistory: [],
    };

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Dorker - Google Dork Parser',
    });

    this.grid = new (contrib as any).grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    this.progressBar = this.grid.set(0, 0, 2, 12, (contrib as any).gauge, {
      label: ' Progress ',
      stroke: 'green',
      fill: 'white',
    });

    this.statsLcd = this.grid.set(2, 0, 2, 3, (contrib as any).lcd, {
      label: ' Requests/sec ',
      elements: 5,
      display: '0',
      color: 'green',
    });

    this.sparkline = this.grid.set(2, 3, 2, 5, (contrib as any).sparkline, {
      label: ' Throughput ',
      tags: true,
    });

    this.proxyDonut = this.grid.set(2, 8, 2, 4, (contrib as any).donut, {
      label: ' Proxies ',
      radius: 8,
      arcWidth: 3,
    });

    this.statsTable = this.grid.set(4, 0, 3, 4, (contrib as any).table, {
      label: ' Statistics ',
      columnWidth: [16, 12],
    });

    this.logBox = this.grid.set(4, 4, 4, 8, (contrib as any).log, {
      label: ' Activity ',
      tags: true,
    });

    this.controlsBox = this.grid.set(7, 0, 1, 4, blessed.box, {
      label: ' Controls ',
      content: '[P] Pause  [Q] Quit',
      tags: true,
    });

    this.setupKeyBindings();
  }

  private setupKeyBindings(): void {
    this.screen.key(['escape', 'q', 'C-c'], () => {
      if (this.onQuit) this.onQuit();
      else { this.destroy(); process.exit(0); }
    });
    this.screen.key(['p'], () => {
      if (this.state.isPaused) { if (this.onResume) this.onResume(); }
      else { if (this.onPause) this.onPause(); }
    });
  }

  setCallbacks(callbacks: {
    onPause?: () => void;
    onResume?: () => void;
    onQuit?: () => void;
    onSpeedUp?: () => void;
    onSpeedDown?: () => void;
  }): void {
    this.onPause = callbacks.onPause;
    this.onResume = callbacks.onResume;
    this.onQuit = callbacks.onQuit;
  }

  updateStats(stats: StatsData): void {
    this.state.stats = stats;
    this.statsLcd.setDisplay(Math.round(stats.requests_per_sec).toString().padStart(5, ' '));
    this.throughputHistory.push(stats.requests_per_sec);
    if (this.throughputHistory.length > this.MAX_HISTORY) this.throughputHistory.shift();
    this.sparkline.setData(['req/s'], [this.throughputHistory]);
    const tableData = [
      ['Dorks Total', formatNumber(stats.tasks_total)],
      ['Completed', formatNumber(stats.tasks_completed)],
      ['Failed', formatNumber(stats.tasks_failed)],
      ['URLs Found', formatNumber(stats.urls_found)],
      ['CAPTCHAs', formatNumber(stats.captcha_count)],
      ['Elapsed', formatDuration(stats.elapsed_ms)],
      ['ETA', formatDuration(stats.eta_ms)],
    ];
    this.statsTable.setData({ headers: ['Metric', 'Value'], data: tableData });
    this.render();
  }

  updateProgress(progress: ProgressData): void {
    this.state.progress = progress;
    const percent = Math.min(100, Math.max(0, progress.percentage));
    this.progressBar.setPercent(percent);
    this.progressBar.setLabel(` Progress: ${formatNumber(progress.current)} / ${formatNumber(progress.total)} (${percent.toFixed(1)}%) `);
    this.render();
  }

  updateProxyInfo(info: ProxyInfo): void {
    this.state.proxyInfo = info;
    const data = [
      { label: `Alive: ${info.alive}`, percent: String(info.total > 0 ? ((info.alive / info.total) * 100).toFixed(0) : 0), color: 'green' },
      { label: `Dead: ${info.dead}`, percent: String(info.total > 0 ? ((info.dead / info.total) * 100).toFixed(0) : 0), color: 'red' },
    ];
    this.proxyDonut.setData(data);
    this.render();
  }

  addActivity(entry: ActivityEntry): void {
    this.state.recentActivity.unshift(entry);
    if (this.state.recentActivity.length > 100) this.state.recentActivity.pop();
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    let color = 'white';
    if (entry.type === 'success') color = 'green';
    else if (entry.type === 'error') color = 'red';
    else if (entry.type === 'warning') color = 'yellow';
    const urlInfo = entry.urls !== undefined ? ` → ${entry.urls} URLs` : '';
    this.logBox.log(`{${color}-fg}${timestamp}{/} ${entry.message}${urlInfo}`);
    this.render();
  }

  log(message: string, type: ActivityEntry['type'] = 'info'): void {
    this.addActivity({ timestamp: Date.now(), type, dork: '', message });
  }

  setPaused(paused: boolean): void {
    this.state.isPaused = paused;
    this.controlsBox.setContent(paused ? '{yellow-fg}PAUSED{/} [P] Resume [Q] Quit' : '[P] Pause [Q] Quit');
    this.render();
  }

  setRunning(running: boolean): void { this.state.isRunning = running; }

  showComplete(stats: StatsData, duration: number): void {
    const box = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 12,
      label: ' Complete ',
      content: `\n  Dorks: ${stats.tasks_completed} completed\n  URLs: ${formatNumber(stats.urls_found)}\n  Duration: ${formatDuration(duration)}\n\n  Press any key to exit...`,
      tags: true,
      border: { type: 'line' },
    });
    this.screen.once('keypress', () => { this.destroy(); process.exit(0); });
    this.screen.render();
  }

  render(): void { this.screen.render(); }
  destroy(): void { this.screen.destroy(); }
  getScreen(): blessed.Widgets.Screen { return this.screen; }
}

export function showBanner(): void {
  console.log('\x1b[36m');
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║                         DORKER v1.0.0                             ║');
  console.log('║                   Google Dork Parser                              ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log('\x1b[0m');
}
