import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export class WorkerIPC extends EventEmitter {
  constructor(workerPath) {
    super();
    this.workerPath = workerPath;
    this.process = null;
    this.readline = null;
    this.connected = false;
    this.queue = [];
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.readline = createInterface({ 
        input: this.process.stdout,
        crlfDelay: Infinity
      });

      this.readline.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          this.handleMessage(msg);
        } catch (e) {
          // Non-JSON output, ignore or log
        }
      });

      this.process.stderr.on('data', (data) => {
        const text = data.toString().trim();
        if (text) {
          this.emit('log', 'debug', text);
        }
      });

      this.process.on('error', (err) => {
        this.emit('error', 'SPAWN_ERROR', err.message);
        reject(err);
      });

      this.process.on('close', (code) => {
        this.connected = false;
        this.emit('close', code);
      });

      // Wait for ready message
      const timeout = setTimeout(() => {
        reject(new Error('Worker startup timeout (10s)'));
      }, 10000);

      this.once('ready', () => {
        clearTimeout(timeout);
        this.connected = true;
        this.flushQueue();
        resolve();
      });
    });
  }

  handleMessage(msg) {
    const { type, data } = msg;

    switch (type) {
      case 'ready':
        this.emit('ready');
        break;

      case 'status':
        this.emit('status', data?.status, data?.message);
        break;

      case 'result':
        this.emit('result', {
          taskId: data?.task_id,
          dork: data?.dork,
          status: data?.status,
          urls: data?.urls || [],
          error: data?.error,
          proxyId: data?.proxy_id,
          duration: data?.duration_ms
        });
        break;

      case 'stats':
        this.emit('stats', {
          tasksTotal: data?.tasks_total || 0,
          tasksCompleted: data?.tasks_completed || 0,
          tasksFailed: data?.tasks_failed || 0,
          tasksPending: data?.tasks_pending || 0,
          urlsFound: data?.urls_found || 0,
          captchaCount: data?.captcha_count || 0,
          blockCount: data?.block_count || 0,
          errorCount: data?.error_count || 0,
          requestsPerSec: data?.requests_per_sec || 0,
          avgResponseTime: data?.avg_response_time || 0,
          elapsedMs: data?.elapsed_ms || 0,
          etaMs: data?.eta_ms || 0
        });
        break;

      case 'progress':
        this.emit('progress', {
          current: data?.current || 0,
          total: data?.total || 0,
          percentage: data?.percentage || 0
        });
        break;

      case 'proxy_info':
        this.emit('proxy_info', {
          alive: data?.alive || 0,
          dead: data?.dead || 0,
          quarantined: data?.quarantined || 0,
          total: data?.total || 0
        });
        break;

      case 'error':
        this.emit('error', data?.code, data?.message);
        break;

      case 'log':
        this.emit('log', data?.level, data?.message);
        break;

      default:
        this.emit('unknown', msg);
    }
  }

  send(type, data = {}) {
    const msg = {
      type,
      timestamp: Date.now(),
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      data
    };

    if (this.connected && this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    } else {
      this.queue.push(msg);
    }
  }

  flushQueue() {
    while (this.queue.length > 0) {
      const msg = this.queue.shift();
      if (this.process?.stdin?.writable) {
        this.process.stdin.write(JSON.stringify(msg) + '\n');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Commands
  // ─────────────────────────────────────────────────────────────

  init(config) {
    this.send('init', {
      workers: config.workers || 10,
      timeout: config.timeout || 30000,
      base_delay: config.baseDelay || 8000,
      min_delay: config.minDelay || 3000,
      max_delay: config.maxDelay || 15000,
      max_retries: config.maxRetries || 3,
      results_per_page: config.resultsPerPage || 100,
      proxy_file: config.proxyFile
    });
  }

  submitTask(dork, taskId, page = 0) {
    this.send('task', {
      task_id: taskId || `task_${Date.now()}`,
      dork,
      page
    });
  }

  submitTasks(dorks) {
    dorks.forEach((dork, i) => {
      this.submitTask(dork, `task_${i}`);
    });
  }

  submitBatch(dorks, batchSize = 100) {
    for (let i = 0; i < dorks.length; i += batchSize) {
      const batch = dorks.slice(i, i + batchSize);
      batch.forEach((dork, j) => {
        this.submitTask(dork, `task_${i + j}`);
      });
    }
  }

  pause() {
    this.send('pause');
  }

  resume() {
    this.send('resume');
  }

  getStats() {
    this.send('get_stats');
  }

  shutdown() {
    this.send('shutdown');
  }

  // ─────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────

  isConnected() {
    return this.connected;
  }

  kill() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
      this.connected = false;
    }
  }
}

export default WorkerIPC;
