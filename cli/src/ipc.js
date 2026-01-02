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
    this.messageQueue = [];
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.readline = createInterface({ input: this.process.stdout });

      this.readline.on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          this.handleMessage(msg);
        } catch (e) {
          // Ignore non-JSON lines
        }
      });

      this.process.stderr.on('data', (data) => {
        // Debug output
      });

      this.process.on('close', (code) => {
        this.connected = false;
        this.emit('close', code);
      });

      this.process.on('error', (err) => {
        reject(err);
      });

      // Wait for ready
      const timeout = setTimeout(() => {
        reject(new Error('Worker startup timeout'));
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
    switch (msg.type) {
      case 'ready':
        this.emit('ready');
        break;
      case 'status':
        this.emit('status', msg.data?.status, msg.data?.message);
        break;
      case 'result':
        this.emit('result', msg.data);
        break;
      case 'stats':
        this.emit('stats', msg.data);
        break;
      case 'progress':
        this.emit('progress', msg.data);
        break;
      case 'proxy_info':
        this.emit('proxy_info', msg.data);
        break;
      case 'error':
        this.emit('error', msg.data?.code, msg.data?.message);
        break;
      case 'log':
        this.emit('log', msg.data?.level, msg.data?.message);
        break;
    }
  }

  send(type, data = {}) {
    const msg = { type, timestamp: Date.now(), id: `msg_${Date.now()}`, data };
    if (this.connected && this.process) {
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    } else {
      this.messageQueue.push(msg);
    }
  }

  flushQueue() {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  init(config) { this.send('init', config); }
  submitTask(task) { this.send('task', task); }
  submitTasks(tasks) { tasks.forEach(t => this.submitTask(t)); }
  pause() { this.send('pause'); }
  resume() { this.send('resume'); }
  getStats() { this.send('get_stats'); }
  shutdown() { this.send('shutdown'); }
  isConnected() { return this.connected; }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
