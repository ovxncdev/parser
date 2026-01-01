/**
 * Engine Orchestrator
 * Spawns and manages the Go core engine process
 * Handles JSON communication between TypeScript and Go
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { nanoid } from 'nanoid';
import type {
  EngineConfig,
  BaseMessage,
  InitMessage,
  TaskMessage,
  ProxyMessage,
  IncomingMessage,
  ReadyMessage,
  ResultMessage,
  ErrorMessage,
  BlockedMessage,
  StatsMessage,
} from '../types/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Engine states
export type EngineState = 'idle' | 'starting' | 'ready' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error';

// Engine events
export interface EngineEvents {
  ready: (message: ReadyMessage) => void;
  result: (message: ResultMessage) => void;
  error: (message: ErrorMessage) => void;
  blocked: (message: BlockedMessage) => void;
  stats: (message: StatsMessage) => void;
  stateChange: (state: EngineState, previousState: EngineState) => void;
  exit: (code: number | null, signal: string | null) => void;
  message: (message: IncomingMessage) => void;
}

export class Engine extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: EngineState = 'idle';
  private binaryPath: string;
  private config: EngineConfig | null = null;
  private messageBuffer: string = '';
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private startTimeout: NodeJS.Timeout | null = null;
  private messageQueue: Array<{ message: BaseMessage; resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(binaryPath?: string) {
    super();
    this.binaryPath = binaryPath || this.findBinary();
  }

  /**
   * Find the Go binary
   */
  private findBinary(): string {
    const possiblePaths = [
      path.join(process.cwd(), 'bin', 'gorker'),
      path.join(process.cwd(), 'bin', 'gorker.exe'),
      path.join(process.cwd(), 'core', 'gorker'),
      path.join(__dirname, '..', '..', 'bin', 'gorker'),
      path.join(__dirname, '..', '..', 'bin', 'gorker.exe'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Default path
    return path.join(process.cwd(), 'bin', 'gorker');
  }

  /**
   * Get current engine state
   */
  getState(): EngineState {
    return this.state;
  }

  /**
   * Set engine state and emit event
   */
  private setState(newState: EngineState): void {
    const previousState = this.state;
    this.state = newState;
    this.emit('stateChange', newState, previousState);
    logger.debug('Engine state changed', { from: previousState, to: newState });
  }

  /**
   * Start the Go engine
   */
  async start(config: EngineConfig): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'stopped' && this.state !== 'error') {
      throw new Error(`Cannot start engine in state: ${this.state}`);
    }

    // Check binary exists
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Engine binary not found: ${this.binaryPath}. Run 'npm run build:go' first.`);
    }

    this.config = config;
    this.setState('starting');

    // Create promise for ready state
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Spawn process
    this.process = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Set up stdout handler (JSON messages from Go)
    const rl = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      this.handleMessage(line);
    });

    // Set up stderr handler (errors/logs from Go)
    this.process.stderr!.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        logger.warn('Engine stderr', { message });
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });

    // Handle process error
    this.process.on('error', (error) => {
      logger.error('Engine process error', { error: error.message });
      this.setState('error');
      if (this.readyReject) {
        this.readyReject(error);
      }
    });

    // Set startup timeout
    this.startTimeout = setTimeout(() => {
      if (this.state === 'starting') {
        const error = new Error('Engine startup timeout');
        logger.error('Engine startup timeout');
        this.setState('error');
        if (this.readyReject) {
          this.readyReject(error);
        }
        this.stop();
      }
    }, 30000);

    // Send init message
    const initMessage: InitMessage = {
      type: 'init',
      timestamp: Date.now(),
      id: nanoid(),
      config,
    };

    this.send(initMessage);

    // Wait for ready
    return this.readyPromise;
  }

  /**
   * Stop the engine
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      return;
    }

    this.setState('stopping');

    // Clear timeout
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }

    // Send stop message
    if (this.process && !this.process.killed) {
      this.send({ type: 'stop', timestamp: Date.now() });

      // Give it time to gracefully shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process!.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this.setState('stopped');
  }

  /**
   * Pause processing
   */
  pause(): void {
    if (this.state !== 'running') {
      return;
    }

    this.send({ type: 'pause', timestamp: Date.now() });
    this.setState('paused');
  }

  /**
   * Resume processing
   */
  resume(): void {
    if (this.state !== 'paused') {
      return;
    }

    this.send({ type: 'resume', timestamp: Date.now() });
    this.setState('running');
  }

  /**
   * Send a task to the engine
   */
  sendTask(dork: string, page: number = 0, proxy?: string): string {
    const taskId = nanoid();

    const message: TaskMessage = {
      type: 'task',
      timestamp: Date.now(),
      task_id: taskId,
      dork,
      page,
      proxy,
    };

    this.send(message);
    return taskId;
  }

  /**
   * Add a proxy to the engine
   */
  addProxy(proxy: string, protocol: string = 'http'): void {
    const message: ProxyMessage = {
      type: 'add_proxy',
      timestamp: Date.now(),
      proxy,
      protocol,
    };

    this.send(message);
  }

  /**
   * Remove a proxy from the engine
   */
  removeProxy(proxy: string, protocol: string = 'http'): void {
    const message: ProxyMessage = {
      type: 'del_proxy',
      timestamp: Date.now(),
      proxy,
      protocol,
    };

    this.send(message);
  }

  /**
   * Request stats from the engine
   */
  requestStats(): void {
    this.send({ type: 'health', timestamp: Date.now() });
  }

  /**
   * Send a message to the Go process
   */
  private send(message: BaseMessage | object): void {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
      logger.warn('Cannot send message, process not available');
      return;
    }

    try {
      const json = JSON.stringify(message);
      this.process.stdin.write(json + '\n');
      logger.trace('Sent message to engine', { type: (message as BaseMessage).type });
    } catch (error) {
      logger.error('Failed to send message', { error });
    }
  }

  /**
   * Handle incoming message from Go
   */
  private handleMessage(line: string): void {
    if (!line.trim()) {
      return;
    }

    try {
      const message = JSON.parse(line) as IncomingMessage;
      logger.trace('Received message from engine', { type: message.type });

      // Emit generic message event
      this.emit('message', message);

      // Handle specific message types
      switch (message.type) {
        case 'ready':
          this.handleReady(message as ReadyMessage);
          break;

        case 'result':
          this.emit('result', message as ResultMessage);
          break;

        case 'error':
          this.handleError(message as ErrorMessage);
          break;

        case 'blocked':
          this.emit('blocked', message as BlockedMessage);
          break;

        case 'stats':
          this.emit('stats', message as StatsMessage);
          break;

        case 'progress':
          this.emit('progress', message);
          break;

        case 'proxy_status':
          this.emit('proxyStatus', message);
          break;

        case 'done':
          this.emit('done', message);
          break;

        default:
          logger.warn('Unknown message type', { type: (message as BaseMessage).type });
      }
    } catch (error) {
      logger.error('Failed to parse message', { line, error });
    }
  }

  /**
   * Handle ready message
   */
  private handleReady(message: ReadyMessage): void {
    // Clear startup timeout
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }

    this.setState('ready');
    logger.engineReady(message.version, message.max_workers, message.proxy_count);

    // Resolve ready promise
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
      this.readyReject = null;
    }

    this.emit('ready', message);
  }

  /**
   * Handle error message
   */
  private handleError(message: ErrorMessage): void {
    logger.error('Engine error', { code: message.code, message: message.message, fatal: message.fatal });

    this.emit('error', message);

    if (message.fatal) {
      this.setState('error');
      if (this.readyReject) {
        this.readyReject(new Error(message.message));
        this.readyResolve = null;
        this.readyReject = null;
      }
    }
  }

  /**
   * Handle process exit
   */
  private handleExit(code: number | null, signal: string | null): void {
    logger.info('Engine process exited', { code, signal });

    // Clean up
    this.process = null;

    if (this.state !== 'stopping' && this.state !== 'stopped') {
      this.setState('error');

      if (this.readyReject) {
        this.readyReject(new Error(`Engine exited unexpectedly with code ${code}`));
        this.readyResolve = null;
        this.readyReject = null;
      }
    } else {
      this.setState('stopped');
    }

    this.emit('exit', code, signal);
  }

  /**
   * Check if engine is running
   */
  isRunning(): boolean {
    return this.state === 'running' || this.state === 'ready' || this.state === 'paused';
  }

  /**
   * Set to running state
   */
  setRunning(): void {
    if (this.state === 'ready' || this.state === 'paused') {
      this.setState('running');
    }
  }

  /**
   * Get engine PID
   */
  getPid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Wait for engine to be ready
   */
  async waitReady(): Promise<void> {
    if (this.state === 'ready' || this.state === 'running') {
      return;
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    throw new Error('Engine not starting');
  }
}

// Singleton instance
let engineInstance: Engine | null = null;

/**
 * Get or create engine instance
 */
export function getEngine(binaryPath?: string): Engine {
  if (!engineInstance) {
    engineInstance = new Engine(binaryPath);
  }
  return engineInstance;
}

/**
 * Reset engine instance
 */
export async function resetEngine(): Promise<void> {
  if (engineInstance) {
    await engineInstance.stop();
    engineInstance = null;
  }
}

export default Engine;
