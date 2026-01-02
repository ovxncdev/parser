/**
 * Real-time Dashboard
 * Full TUI dashboard using blessed for real-time updates
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { SchedulerStats } from '../orchestrator/scheduler.js';

// Dashboard state
interface DashboardState {
  phase: 'init' | 'proxy_check' | 'running' | 'paused' | 'complete' | 'error';
  stats: SchedulerStats | null;
  proxyStats: {
    total: number;
    alive: number;
    dead: number;
    slow: number;
    checked: number;
  };
  activityLog: Array<{
    time: string;
    type: 'success' | 'warning' | 'error' | 'info';
    dork: string;
    message: string;
  }>;
  requestHistory: number[];
  alerts: Array<{
    type: 'warning' | 'critical';
    message: string;
    actions?: string[];
  }>;
  config: {
    dorks: number;
    proxies: number;
    workers: number;
    pagesPerDork: number;
  };
}

export class Dashboard {
  private screen: blessed.Widgets.Screen | null = null;
  private grid: any = null;
  private widgets: {
    header?: blessed.Widgets.BoxElement;
    progress?: any;
    stats?: blessed.Widgets.BoxElement;
    chart?: any;
    activity?: any;
    alert?: blessed.Widgets.BoxElement;
    footer?: blessed.Widgets.BoxElement;
  } = {};
  private state: DashboardState;
  private updateInterval: NodeJS.Timeout | null = null;
  private eventHandlers: Map<string, Function[]> = new Map();

  constructor() {
    this.state = {
      phase: 'init',
      stats: null,
      proxyStats: { total: 0, alive: 0, dead: 0, slow: 0, checked: 0 },
      activityLog: [],
      requestHistory: new Array(60).fill(0),
      alerts: [],
      config: { dorks: 0, proxies: 0, workers: 0, pagesPerDork: 0 },
    };
  }

  init(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'DORKER - Google Dork Parser',
      fullUnicode: true,
    });

    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    this.createWidgets();
    this.setupKeyBindings();
    this.screen.render();
  }

  private createWidgets(): void {
    if (!this.grid || !this.screen) return;

    this.widgets.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 9,
      content: this.getHeaderContent(),
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
    });

    this.widgets.progress = this.grid.set(3, 0, 2, 8, contrib.gauge, {
      label: ' PROGRESS ',
      stroke: 'cyan',
      fill: 'white',
      border: { type: 'line', fg: 'cyan' },
    });

    this.widgets.stats = this.grid.set(3, 8, 4, 4, blessed.box, {
      label: ' LIVE STATS ',
      tags: true,
      border: { type: 'line', fg: 'cyan' },
      style: { border: { fg: 'cyan' } },
    });

    this.widgets.chart = this.grid.set(5, 0, 3, 8, contrib.sparkline, {
      label: ' REQUESTS/SEC (Last 60s) ',
      tags: true,
      border: { type: 'line', fg: 'cyan' },
      style: { fg: 'cyan' },
    });

    this.widgets.activity = this.grid.set(7, 0, 4, 8, contrib.log, {
      label: ' RECENT ACTIVITY ',
      tags: true,
      border: { type: 'line', fg: 'cyan' },
      style: { border: { fg: 'cyan' } },
      bufferLength: 50,
    });

    this.widgets.alert = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 70,
      height: 10,
      hidden: true,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'red' }, bg: 'black' },
    });

    this.widgets.footer = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: ' {cyan-fg}[P]{/} Pause  {cyan-fg}[R]{/} Resume  {cyan-fg}[S]{/} Save & Quit  {cyan-fg}[Q]{/} Quit  {cyan-fg}[H]{/} Help ',
      tags: true,
      style: { bg: 'blue' },
    });
  }

  private getHeaderContent(): string {
    return `{center}{cyan-fg}
██████╗  ██████╗ ██████╗ ██╗  ██╗███████╗██████╗ 
██╔══██╗██╔═══██╗██╔══██╗██║ ██╔╝██╔════╝██╔══██╗
██║  ██║██║   ██║██████╔╝█████╔╝ █████╗  ██████╔╝
██║  ██║██║   ██║██╔══██╗██╔═██╗ ██╔══╝  ██╔══██╗
██████╔╝╚██████╔╝██║  ██║██║  ██╗███████╗██║  ██║
╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝{/}

{white-fg}Google Dork Parser v1.0.0{/}{/center}`;
  }

  private setupKeyBindings(): void {
    if (!this.screen) return;

    this.screen.key(['q', 'C-c'], () => {
      this.destroy();
      process.exit(0);
    });

    this.screen.key(['p'], () => { this.emit('pause'); });
    this.screen.key(['r'], () => { this.emit('resume'); });
    this.screen.key(['s'], () => { this.emit('save'); });
    this.screen.key(['h'], () => { this.showHelp(); });

    this.screen.key(['enter'], () => {
      if (this.widgets.alert && !this.widgets.alert.hidden) {
        this.widgets.alert.hide();
        this.screen?.render();
      }
    });
  }

  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  private emit(event: string, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(h => h(...args));
    }
  }

  showInit(config: { dorks: number; proxies: number; workers: number; pagesPerDork: number }): void {
    this.state.phase = 'init';
    this.state.config = config;

    if (this.widgets.stats) {
      this.widgets.stats.setContent(`
{bold}Configuration:{/bold}

  Dorks:        {yellow-fg}${config.dorks.toLocaleString()}{/}
  Proxies:      {yellow-fg}${config.proxies.toLocaleString()}{/}
  Workers:      {yellow-fg}${config.workers}{/}
  Pages/Dork:   {yellow-fg}${config.pagesPerDork}{/}

{gray-fg}Initializing...{/}
`);
    }

    this.render();
  }

  showProxyCheck(checked: number, total: number, alive: number, dead: number, slow: number): void {
    this.state.phase = 'proxy_check';
    this.state.proxyStats = { total, alive, dead, slow, checked };

    const percent = Math.round((checked / total) * 100);
    
    if (this.widgets.progress) {
      this.widgets.progress.setPercent(percent);
    }

    if (this.widgets.stats) {
      const alivePercent = checked > 0 ? ((alive / checked) * 100).toFixed(1) : '0.0';
      const deadPercent = checked > 0 ? ((dead / checked) * 100).toFixed(1) : '0.0';
      const slowPercent = checked > 0 ? ((slow / checked) * 100).toFixed(1) : '0.0';

      this.widgets.stats.setLabel(' PROXY HEALTH ');
      this.widgets.stats.setContent(`
{bold}Testing Proxies:{/bold}

  Checked:  {cyan-fg}${checked.toLocaleString()}{/} / ${total.toLocaleString()}

  {green-fg}✔ Alive:{/}  ${alive.toLocaleString()}  (${alivePercent}%)
  {red-fg}✖ Dead:{/}   ${dead.toLocaleString()}  (${deadPercent}%)
  {yellow-fg}⚠ Slow:{/}   ${slow.toLocaleString()}  (${slowPercent}%)
`);
    }

    this.render();
  }

  showProxyCheckComplete(): void {
    const { alive, total } = this.state.proxyStats;
    const recommended = Math.min(alive, Math.floor(alive * 0.1));
    const estHours = (this.state.config.dorks * this.state.config.pagesPerDork) / (alive * 20 / 60);

    this.addActivity('info', '', `Proxy check complete: ${alive}/${total} alive`);
    this.addActivity('info', '', `Recommended workers: ${recommended}`);
    this.addActivity('info', '', `Estimated time: ~${estHours.toFixed(1)} hours`);
  }

  updateStats(stats: SchedulerStats): void {
    this.state.phase = 'running';
    this.state.stats = stats;

    const percent = stats.totalDorks > 0 ? (stats.completedDorks / stats.totalDorks) * 100 : 0;
    
    if (this.widgets.progress) {
      this.widgets.progress.setPercent(percent);
    }

    if (this.widgets.stats) {
      this.widgets.stats.setLabel(' LIVE STATS ');
      this.widgets.stats.setContent(`
{bold}Progress:{/bold}
  {cyan-fg}${stats.completedDorks.toLocaleString()}{/} / ${stats.totalDorks.toLocaleString()} ({white-fg}${percent.toFixed(1)}%{/})

{bold}Performance:{/bold}
  Req/min:      {yellow-fg}${stats.requestsPerMin.toFixed(0)}{/}
  URLs/min:     {yellow-fg}${stats.urlsPerMin.toFixed(0)}{/}
  Success:      {green-fg}${stats.successRate.toFixed(1)}%{/}

{bold}Results:{/bold}
  URLs found:   {cyan-fg}${stats.totalUrls.toLocaleString()}{/}
  Unique:       {cyan-fg}${stats.uniqueUrls.toLocaleString()}{/}

{bold}Proxies:{/bold}
  Active:       {green-fg}${stats.currentConcurrency}{/}
  Blocks:       {red-fg}${stats.blockCount}{/}
  CAPTCHAs:     {red-fg}${stats.captchaCount}{/}

{bold}Time:{/bold}
  Elapsed:      {gray-fg}${this.formatDuration(stats.elapsed)}{/}
  ETA:          {green-fg}${stats.eta}{/}
`);
    }

    this.state.requestHistory.shift();
    this.state.requestHistory.push(Math.round(stats.requestsPerMin / 60));
    
    if (this.widgets.chart) {
      this.widgets.chart.setData(['req/s'], [this.state.requestHistory]);
    }

    this.checkAlerts(stats);
    this.render();
  }

  private checkAlerts(stats: SchedulerStats): void {
    if (stats.captchaCount > 10 && stats.completedDorks > 100) {
      const captchaRate = (stats.captchaCount / stats.completedDorks) * 100;
      if (captchaRate > 10) {
        this.showAlert('warning', 
          `High CAPTCHA rate detected (${captchaRate.toFixed(1)}% in last 5 min)\nAuto-adjusting: Reducing speed, rotating proxies faster`
        );
      }
    }

    if (stats.currentConcurrency < 50 && stats.currentConcurrency < this.state.config.workers * 0.3) {
      this.showAlert('critical',
        `Proxy pool running low: ${stats.currentConcurrency} remaining\nConsider pausing and adding more proxies`,
        ['[P] Pause', '[C] Continue', '[Q] Save & Quit']
      );
    }
  }

  showAlert(type: 'warning' | 'critical', message: string, actions?: string[]): void {
    if (!this.widgets.alert) return;

    const title = type === 'critical' ? ' 🔴 CRITICAL ' : ' ⚠ WARNING ';
    const borderColor = type === 'critical' ? 'red' : 'yellow';

    this.widgets.alert.setLabel(title);
    this.widgets.alert.style.border!.fg = borderColor;
    
    let content = `\n${message}`;
    if (actions) {
      content += `\n\n${actions.join('    ')}`;
    }
    content += '\n\n{gray-fg}Press ENTER to dismiss{/}';
    
    this.widgets.alert.setContent(content);
    this.widgets.alert.show();
    this.widgets.alert.focus();
    this.render();
  }

  addActivity(type: 'success' | 'warning' | 'error' | 'info', dork: string, message: string): void {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    
    let icon: string;
    let color: string;
    switch (type) {
      case 'success': icon = '✔'; color = 'green'; break;
      case 'warning': icon = '⚠'; color = 'yellow'; break;
      case 'error': icon = '✖'; color = 'red'; break;
      default: icon = 'ℹ'; color = 'cyan'; break;
    }

    const dorkShort = dork.length > 30 ? dork.substring(0, 27) + '...' : dork;
    const logLine = `{gray-fg}${time}{/}  {${color}-fg}${icon}{/}  ${dorkShort.padEnd(32)} → ${message}`;

    if (this.widgets.activity) {
      this.widgets.activity.log(logLine);
    }

    this.state.activityLog.unshift({ time, type, dork, message });
    if (this.state.activityLog.length > 100) {
      this.state.activityLog.pop();
    }
  }

  showComplete(stats: SchedulerStats, outputDir: string, files: string[]): void {
    this.state.phase = 'complete';

    if (this.widgets.chart) this.widgets.chart.hide();
    if (this.widgets.activity) this.widgets.activity.hide();

    if (this.widgets.progress) {
      this.widgets.progress.setPercent(100);
      this.widgets.progress.setLabel(' COMPLETE ');
    }

    if (this.widgets.stats) {
      this.widgets.stats.setLabel(' RESULTS ');
      this.widgets.stats.top = 3;
      this.widgets.stats.height = '80%';
      this.widgets.stats.width = '100%-2';
      this.widgets.stats.setContent(`
{bold}{green-fg}✔ All ${stats.totalDorks.toLocaleString()} dorks processed{/}{/bold}

{bold}Duration:{/bold}         ${this.formatDuration(stats.elapsed)}
{bold}Total requests:{/bold}   ${stats.completedDorks.toLocaleString()}
{bold}Success rate:{/bold}     ${stats.successRate.toFixed(1)}%

{bold}─── RESULTS ──────────────────────────────────────{/bold}

  Raw URLs:              {cyan-fg}${stats.totalUrls.toLocaleString()}{/}
  After dedup:           {cyan-fg}${stats.uniqueUrls.toLocaleString()}{/}

{bold}─── OUTPUT FILES ─────────────────────────────────{/bold}

  {gray-fg}${outputDir}/{/}
${files.map(f => `    ├── ${f}`).join('\n')}

{center}{gray-fg}Press any key to exit...{/}{/center}
`);
    }

    if (this.screen) {
      this.screen.once('keypress', () => {
        this.destroy();
        process.exit(0);
      });
    }

    this.render();
  }

  private showHelp(): void {
    if (!this.screen) return;

    const helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 18,
      label: ' HELP ',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      content: `
{bold}Keyboard Shortcuts:{/bold}

  {cyan-fg}P{/}        Pause scanning
  {cyan-fg}R{/}        Resume scanning
  {cyan-fg}S{/}        Save progress & quit
  {cyan-fg}Q{/}        Quit (progress saved)
  {cyan-fg}H{/}        Show this help
  {cyan-fg}Enter{/}    Dismiss alerts

{bold}Status Icons:{/bold}

  {green-fg}✔{/}  Success     {yellow-fg}⚠{/}  Warning
  {red-fg}✖{/}  Error       {cyan-fg}ℹ{/}  Info

{gray-fg}Press any key to close...{/}
`
    });

    this.screen.once('keypress', () => {
      helpBox.destroy();
      this.render();
    });

    this.render();
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  private render(): void {
    if (this.screen) {
      this.screen.render();
    }
  }

  startRefresh(intervalMs: number = 500): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.updateInterval = setInterval(() => {
      this.render();
    }, intervalMs);
  }

  stopRefresh(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  destroy(): void {
    this.stopRefresh();
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }
  }

  isActive(): boolean {
    return this.screen !== null;
  }
}

let dashboardInstance: Dashboard | null = null;

export function getDashboard(): Dashboard {
  if (!dashboardInstance) {
    dashboardInstance = new Dashboard();
  }
  return dashboardInstance;
}

export function resetDashboard(): void {
  if (dashboardInstance) {
    dashboardInstance.destroy();
    dashboardInstance = null;
  }
}

export default Dashboard;
