/**
 * Go Engine Manager
 * Manages the Go subprocess that handles HTTP requests
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { getLogger } from '../utils/logger.js';
import type {
  EngineConfig,
  BaseMessage,
  ConfigMessage,
  SearchMessage,
  ProxyMessage,
  ResultMessage,
  ErrorMessage,
  StatusMessage,
} from '../types/index.js';

const logger = getLogger();

// Engine states
export type EngineState = 'idle' | 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'error';

// Engine events
export interface EngineEvents {
  ready: () => void;
  result: (result: ResultMessage) => void;
  error: (error: ErrorMessage) => void;
  status: (status: StatusMessage) => void;
  stateChange: (state: EngineState) => void;
  exit: (code: number | null) => void;
}

export class Engine extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: EngineState = 'idle';
  private binaryPath: string;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private startTimeout: NodeJS.Timeout | null = null;

  constructor(binaryPath?: string) {
    super();
    this.binaryPath = binaryPath || this.findBinary();
  }

  /**
   * Find the Go binary
   */
  private findBinary(): string {
    const possiblePaths = [
      './core/bin/gorker',
      './bin/gorker',
      path.join(__dirname, '../../core/bin/gorker'),
      path.join(__dirname, '../../../core/bin/gorker'),
      '/usr/local/bin/gorker',
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Default - will fail if not found
    return './core/bin/gorker';
  }

  /**
   * Get current state
   */
  getState(): EngineState {
    return this.state;
  }

  /**
   * Set state and emit event
   */
  private setState(state: EngineState): void {
    this.state = state;
    this.emit('stateChange', state);
    logger.debug('Engine state changed', { state });
  }

  /**
   * Start the engine
   */
  async start(config: EngineConfig): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'stopped' && this.state !== 'error') {
      throw new Error(`Cannot start engine in state: ${this.state}`);
    }

    this.setState('starting');

    // Check binary exists
    if (!fs.existsSync(this.binaryPath)) {
      this.setState('error');
      throw new Error(`Engine binary not found: ${this.binaryPath}. Run 'npm run build:go' first.`);
    }

    // Create promise for ready state
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Set timeout for startup
    this.startTimeout = setTimeout(() => {
      if (this.state === 'starting') {
        this.setState('error');
        if (this.readyReject) {
          this.readyReject(new Error('Engine startup timed out'));
        }
        this.stop();
      }
    }, 30000);

    // Spawn process
    this.process = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Handle stdout (JSON messages)
    let stdoutBuffer = '';
    this.process.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      
      // Process complete lines
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(line.trim());
        }
      }
    });

    // Handle stderr (logs)
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        logger.debug('Engine stderr', { message: msg });
      }
    });

    // Handle process exit
    this.process.on('exit', (code) => {
      logger.info('Engine process exited', { code });
      this.setState('stopped');
      this.emit('exit', code);
      this.cleanup();
    });

    // Handle process error
    this.process.on('error', (error) => {
      logger.error('Engine process error', { error });
      this.setState('error');
      if (this.readyReject) {
        this.readyReject(error);
      }
      this.emit('error', { type: 'error', id: '', error: error.message });
    });

    // Send configuration
    this.sendMessage({
      type: 'config',
      id: 'init',
      config,
    } as ConfigMessage);

    // Wait for ready
    await this.readyPromise;
  }

  /**
   * Handle incoming message from engine
   */
  private handleMessage(line: string): void {
    try {
      const message = JSON.parse(line) as BaseMessage;

      switch (message.type) {
        case 'ready':
          this.handleReady();
          break;
        case 'result':
          this.emit('result', message as ResultMessage);
          break;
        case 'error':
          this.emit('error', message as ErrorMessage);
          break;
        case 'status':
          this.emit('status', message as StatusMessage);
          break;
        default:
          logger.warn('Unknown message type from engine', { type: message.type });
      }
    } catch (error) {
      logger.error('Failed to parse engine message', { line, error });
    }
  }

  /**
   * Handle ready message
   */
  private handleReady(): void {
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }

    this.setState('ready');
    
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
      this.readyReject = null;
    }

    this.emit('ready');
    logger.info('Engine ready');
  }

  /**
   * Send message to engine
   */
  sendMessage(message: BaseMessage): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('Engine not running');
    }

    const line = JSON.stringify(message) + '\n';
    this.process.stdin.write(line);
  }

  /**
   * Submit a search task
   */
  search(id: string, dork: string, page: number = 0): void {
    this.sendMessage({
      type: 'search',
      id,
      dork,
      page,
    } as SearchMessage);
  }

  /**
   * Add proxies
   */
  addProxies(proxies: string[]): void {
    this.sendMessage({
      type: 'proxy',
      id: 'add_proxies',
      action: 'add',
      proxies,
    } as ProxyMessage);
  }

  /**
   * Remove proxy
   */
  removeProxy(proxy: string): void {
    this.sendMessage({
      type: 'proxy',
      id: 'remove_proxy',
      action: 'remove',
      proxies: [proxy],
    } as ProxyMessage);
  }

  /**
   * Get proxy status
   */
  getProxyStatus(): void {
    this.sendMessage({
      type: 'proxy',
      id: 'proxy_status',
      action: 'status',
      proxies: [],
    } as ProxyMessage);
  }

  /**
   * Pause engine
   */
  pause(): void {
    this.sendMessage({
      type: 'control',
      id: 'pause',
      action: 'pause',
    } as BaseMessage & { action: string });
  }

  /**
   * Resume engine
   */
  resume(): void {
    this.sendMessage({
      type: 'control',
      id: 'resume',
      action: 'resume',
    } as BaseMessage & { action: string });
  }

  /**
   * Stop the engine gracefully
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      return;
    }

    this.setState('stopping');

    // Send shutdown command
    try {
      this.sendMessage({
        type: 'control',
        id: 'shutdown',
        action: 'shutdown',
      } as BaseMessage & { action: string });
    } catch {
      // Process might already be gone
    }

    // Wait a bit for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Force kill if still running
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      
      // Force kill after timeout
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }

    this.cleanup();
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }
    this.process = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  /**
   * Check if engine is running
   */
  isRunning(): boolean {
    return this.state === 'ready' || this.state === 'running';
  }
}

// Singleton instance
let engineInstance: Engine | null = null;

export function getEngine(binaryPath?: string): Engine {
  if (!engineInstance) {
    engineInstance = new Engine(binaryPath);
  }
  return engineInstance;
}

export async function resetEngine(): Promise<void> {
  if (engineInstance) {
    await engineInstance.stop();
    engineInstance = null;
  }
}

export default Engine;
