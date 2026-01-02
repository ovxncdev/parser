import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import path from 'node:path';
import type {
  IPCMessage,
  MessageType,
  InitConfig,
  TaskData,
  ResultData,
  StatsData,
  ProgressData,
  ProxyInfo,
} from './types.js';

export interface IPCEvents {
  ready: (version: string) => void;
  status: (status: string, message?: string) => void;
  result: (data: ResultData) => void;
  stats: (data: StatsData) => void;
  progress: (data: ProgressData) => void;
  proxy_info: (data: ProxyInfo) => void;
  error: (code: string, message: string) => void;
  log: (level: string, message: string) => void;
  close: (code: number | null) => void;
}

export class WorkerIPC extends EventEmitter {
  private worker: ChildProcess | null = null;
  private readline: Interface | null = null;
  private workerPath: string;
  private isReady = false;
  private messageQueue: IPCMessage[] = [];

  constructor(workerPath?: string) {
    super();
    // Default to looking for worker binary in ../bin/worker relative to cli
    this.workerPath = workerPath || this.findWorkerPath();
  }

  private findWorkerPath(): string {
    // Try multiple locations
    const possiblePaths = [
      path.join(process.cwd(), 'bin', 'worker'),
      path.join(process.cwd(), '..', 'bin', 'worker'),
      path.join(__dirname, '..', '..', 'bin', 'worker'),
      path.join(__dirname, '..', '..', '..', 'bin', 'worker'),
    ];

    // For Windows
    if (process.platform === 'win32') {
      possiblePaths.push(
        ...possiblePaths.map((p) => p + '.exe')
      );
    }

    // Return first path (actual existence check would need fs)
    return possiblePaths[0] as string;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.worker = spawn(this.workerPath, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.worker.stdout || !this.worker.stdin) {
          throw new Error('Failed to create worker process pipes');
        }

        // Set up readline for stdout
        this.readline = createInterface({
          input: this.worker.stdout,
          crlfDelay: Infinity,
        });

        this.readline.on('line', (line) => {
          this.handleLine(line);
        });

        // Handle stderr for logging
        this.worker.stderr?.on('data', (data: Buffer) => {
          const message = data.toString().trim();
          if (message) {
            this.emit('log', 'debug', message);
          }
        });

        // Handle close
        this.worker.on('close', (code) => {
          this.isReady = false;
          this.emit('close', code);
        });

        // Handle error
        this.worker.on('error', (err) => {
          reject(err);
        });

        // Wait for ready message
        const readyTimeout = setTimeout(() => {
          reject(new Error('Worker did not send ready message within timeout'));
        }, 10000);

        this.once('ready', () => {
          clearTimeout(readyTimeout);
          this.isReady = true;
          // Process queued messages
          this.flushQueue();
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line) as IPCMessage;
      this.handleMessage(message);
    } catch {
      this.emit('log', 'warn', `Failed to parse message: ${line}`);
    }
  }

  private handleMessage(message: IPCMessage): void {
    const data = message.data || {};

    switch (message.type) {
      case 'status': {
        const status = data['status'] as string;
        const msg = data['message'] as string | undefined;
        
        if (status === 'ready') {
          const version = data['version'] as string || '1.0.0';
          this.emit('ready', version);
        } else {
          this.emit('status', status, msg);
        }
        break;
      }

      case 'result': {
        const result: ResultData = {
          task_id: data['task_id'] as string,
          dork: data['dork'] as string,
          urls: data['urls'] as string[] || [],
          status: data['status'] as ResultData['status'],
          error: data['error'] as string | undefined,
          proxy_id: data['proxy_id'] as string,
          duration_ms: data['duration_ms'] as number,
        };
        this.emit('result', result);
        break;
      }

      case 'stats': {
        const stats: StatsData = {
          tasks_total: data['tasks_total'] as number || 0,
          tasks_completed: data['tasks_completed'] as number || 0,
          tasks_failed: data['tasks_failed'] as number || 0,
          tasks_pending: data['tasks_pending'] as number || 0,
          urls_found: data['urls_found'] as number || 0,
          captcha_count: data['captcha_count'] as number || 0,
          block_count: data['block_count'] as number || 0,
          proxies_alive: data['proxies_alive'] as number || 0,
          proxies_dead: data['proxies_dead'] as number || 0,
          requests_per_sec: data['requests_per_sec'] as number || 0,
          elapsed_ms: data['elapsed_ms'] as number || 0,
          eta_ms: data['eta_ms'] as number || 0,
        };
        this.emit('stats', stats);
        break;
      }

      case 'progress': {
        const progress: ProgressData = {
          current: data['current'] as number || 0,
          total: data['total'] as number || 0,
          percentage: data['percentage'] as number || 0,
        };
        this.emit('progress', progress);
        break;
      }

      case 'proxy_info': {
        const proxyInfo: ProxyInfo = {
          alive: data['alive'] as number || 0,
          dead: data['dead'] as number || 0,
          quarantined: data['quarantined'] as number || 0,
          total: data['total'] as number || 0,
        };
        this.emit('proxy_info', proxyInfo);
        break;
      }

      case 'error': {
        const code = data['code'] as string || 'unknown';
        const errorMsg = data['message'] as string || 'Unknown error';
        this.emit('error', code, errorMsg);
        break;
      }

      case 'log': {
        const level = data['level'] as string || 'info';
        const logMsg = data['message'] as string || '';
        this.emit('log', level, logMsg);
        break;
      }

      default:
        this.emit('log', 'warn', `Unknown message type: ${message.type}`);
    }
  }

  private send(message: IPCMessage): void {
    if (!this.isReady) {
      this.messageQueue.push(message);
      return;
    }

    if (!this.worker?.stdin?.writable) {
      throw new Error('Worker stdin is not writable');
    }

    const line = JSON.stringify(message) + '\n';
    this.worker.stdin.write(line);
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        this.send(message);
      }
    }
  }

  private createMessage(type: MessageType, data?: Record<string, unknown>): IPCMessage {
    return {
      type,
      ts: Date.now(),
      data,
    };
  }

  // Public methods

  init(config: InitConfig): void {
    this.send(this.createMessage('init', {
      workers: config.workers,
      timeout: config.timeout,
      base_delay: config.base_delay,
      min_delay: config.min_delay,
      max_delay: config.max_delay,
      max_retries: config.max_retries,
      results_per_page: config.results_per_page,
      proxies: config.proxies,
      proxy_file: config.proxy_file,
    }));
  }

  submitTask(task: TaskData): void {
    this.send(this.createMessage('task', {
      task_id: task.task_id,
      dork: task.dork,
      page: task.page || 0,
    }));
  }

  submitTasks(tasks: TaskData[]): void {
    this.send(this.createMessage('task_batch', {
      tasks: tasks.map((t) => ({
        id: t.task_id,
        dork: t.dork,
        page: t.page || 0,
      })),
    }));
  }

  pause(): void {
    this.send(this.createMessage('pause'));
  }

  resume(): void {
    this.send(this.createMessage('resume'));
  }

  getStats(): void {
    this.send(this.createMessage('get_stats'));
  }

  shutdown(): void {
    this.send(this.createMessage('shutdown'));
  }

  stop(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.worker) {
      this.worker.kill('SIGTERM');
      this.worker = null;
    }

    this.isReady = false;
  }

  isConnected(): boolean {
    return this.isReady && this.worker !== null;
  }
}

// Type-safe event emitter
export interface WorkerIPC {
  on<K extends keyof IPCEvents>(event: K, listener: IPCEvents[K]): this;
  once<K extends keyof IPCEvents>(event: K, listener: IPCEvents[K]): this;
  emit<K extends keyof IPCEvents>(event: K, ...args: Parameters<IPCEvents[K]>): boolean;
  off<K extends keyof IPCEvents>(event: K, listener: IPCEvents[K]): this;
}
