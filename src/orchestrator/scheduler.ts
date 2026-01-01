/**
 * Scheduler
 * Dynamic task scheduling with adaptive concurrency and rate limiting
 */

import { EventEmitter } from 'events';
import type {
  ResultMessage,
  ErrorMessage,
  BlockedMessage,
  StatsMessage,
  EngineConfig,
} from '../types/index.js';
import { Engine, getEngine } from './engine.js';
import { TaskQueue, getTaskQueue, TaskPriority } from './taskQueue.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Scheduler states
export type SchedulerState = 'idle' | 'running' | 'paused' | 'stopping' | 'stopped' | 'completed';

// Scheduler events
export interface SchedulerEvents {
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  complete: (stats: SchedulerStats) => void;
  progress: (stats: SchedulerStats) => void;
  result: (dork: string, urls: string[]) => void;
  error: (dork: string, error: string) => void;
  blocked: (dork: string, reason: string) => void;
}

// Scheduler statistics
export interface SchedulerStats {
  state: SchedulerState;
  startTime: Date;
  elapsed: number;
  totalDorks: number;
  completedDorks: number;
  failedDorks: number;
  pendingDorks: number;
  runningTasks: number;
  totalUrls: number;
  uniqueUrls: number;
  requestsPerMin: number;
  urlsPerMin: number;
  successRate: number;
  eta: string;
  currentConcurrency: number;
  activeProxies: number;
  captchaCount: number;
  blockCount: number;
}

// Scheduler options
export interface SchedulerOptions {
  initialConcurrency?: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  adaptiveConcurrency?: boolean;
  targetSuccessRate?: number;
  statsInterval?: number;
  autoPages?: boolean;
  pagesPerDork?: number;
  maxRetries?: number;
}

const DEFAULT_OPTIONS: Required<SchedulerOptions> = {
  initialConcurrency: 50,
  minConcurrency: 10,
  maxConcurrency: 200,
  adaptiveConcurrency: true,
  targetSuccessRate: 90,
  statsInterval: 1000,
  autoPages: true,
  pagesPerDork: 5,
  maxRetries: 3,
};

export class Scheduler extends EventEmitter {
  private engine: Engine;
  private queue: TaskQueue;
  private options: Required<SchedulerOptions>;
  private state: SchedulerState = 'idle';
  private startTime: Date | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private processTimer: NodeJS.Timeout | null = null;
  private currentConcurrency: number;
  private totalDorks: number = 0;
  private captchaCount: number = 0;
  private blockCount: number = 0;
  private recentResults: Array<{ success: boolean; timestamp: number }> = [];
  private urlSet: Set<string> = new Set();
  private allUrls: string[] = [];

  constructor(options: SchedulerOptions = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.currentConcurrency = this.options.initialConcurrency;
    this.engine = getEngine();
    this.queue = getTaskQueue({
      maxConcurrent: this.currentConcurrency,
      maxRetries: this.options.maxRetries,
      pagesPerDork: this.options.pagesPerDork,
    });

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for engine and queue
   */
  private setupEventHandlers(): void {
    // Engine events
    this.engine.on('result', (message: ResultMessage) => {
      this.handleResult(message);
    });

    this.engine.on('error', (message: ErrorMessage) => {
      this.handleError(message);
    });

    this.engine.on('blocked', (message: BlockedMessage) => {
      this.handleBlocked(message);
    });

    this.engine.on('stats', (message: StatsMessage) => {
      this.handleStats(message);
    });

    // Queue events
    this.queue.on('queueDrained', () => {
      this.handleQueueDrained();
    });
  }

  /**
   * Initialize and start the scheduler
   */
  async start(dorks: string[], config: EngineConfig): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'stopped' && this.state !== 'completed') {
      throw new Error(`Cannot start scheduler in state: ${this.state}`);
    }

    logger.info('Starting scheduler', { dorkCount: dorks.length });

    // Reset state
    this.reset();
    this.totalDorks = dorks.length;
    this.startTime = new Date();

    // Add dorks to queue
    this.queue.addDorks(dorks, TaskPriority.NORMAL);

    // Start engine
    await this.engine.start(config);

    // Start processing
    this.state = 'running';
    this.emit('start');

    // Start stats timer
    this.startStatsTimer();

    // Start processing loop
    this.processQueue();
  }

  /**
   * Pause processing
   */
  pause(): void {
    if (this.state !== 'running') {
      return;
    }

    this.state = 'paused';
    this.engine.pause();
    this.queue.pause();
    this.stopTimers();

    this.emit('pause');
    logger.info('Scheduler paused');
  }

  /**
   * Resume processing
   */
  resume(): void {
    if (this.state !== 'paused') {
      return;
    }

    this.state = 'running';
    this.engine.resume();
    this.queue.resume();
    this.startStatsTimer();
    this.processQueue();

    this.emit('resume');
    logger.info('Scheduler resumed');
  }

  /**
   * Stop processing
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      return;
    }

    this.state = 'stopping';
    this.stopTimers();

    await this.engine.stop();
    this.queue.pause();

    this.state = 'stopped';
    this.emit('stop');
    logger.info('Scheduler stopped');
  }

  /**
   * Process the queue
   */
  private processQueue(): void {
    if (this.state !== 'running') {
      return;
    }

    // Get available slots
    const availableSlots = this.currentConcurrency - this.queue.getRunningCount();

    if (availableSlots <= 0) {
      // Schedule next check
      this.scheduleNextProcess(100);
      return;
    }

    // Get next batch of tasks
    const tasks = this.queue.getNextBatch(availableSlots);

    if (tasks.length === 0) {
      if (!this.queue.hasRunning()) {
        // No more tasks
        return;
      }
      // Wait for running tasks
      this.scheduleNextProcess(100);
      return;
    }

    // Send tasks to engine
    for (const task of tasks) {
      this.engine.sendTask(task.dork, task.page);
    }

    this.engine.setRunning();

    // Schedule next processing
    this.scheduleNextProcess(50);
  }

  /**
   * Schedule next queue processing
   */
  private scheduleNextProcess(delay: number): void {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }

    this.processTimer = setTimeout(() => {
      this.processQueue();
    }, delay);
  }

  /**
   * Handle result from engine
   */
  private handleResult(message: ResultMessage): void {
    // Record success
    this.recordResult(true);

    // Store URLs
    for (const url of message.urls) {
      this.allUrls.push(url);
      this.urlSet.add(url);
    }

    // Complete task in queue
    this.queue.complete(message.task_id, message.urls, message.has_next_page && this.options.autoPages);

    // Emit result event
    this.emit('result', message.dork, message.urls);

    // Adjust concurrency if needed
    if (this.options.adaptiveConcurrency) {
      this.adjustConcurrency();
    }
  }

  /**
   * Handle error from engine
   */
  private handleError(message: ErrorMessage): void {
    if (message.task_id) {
      this.recordResult(false);
      this.queue.fail(message.task_id, message.message, !message.fatal);
      this.emit('error', message.task_id, message.message);
    }

    if (message.fatal) {
      logger.error('Fatal engine error', { message: message.message });
      this.stop();
    }
  }

  /**
   * Handle blocked notification
   */
  private handleBlocked(message: BlockedMessage): void {
    this.recordResult(false);
    this.blockCount++;

    if (message.reason === 'captcha') {
      this.captchaCount++;
    }

    this.queue.block(message.task_id, message.reason);
    this.emit('blocked', message.dork, message.reason);

    // Reduce concurrency on blocks
    if (this.options.adaptiveConcurrency) {
      this.reduceConcurrency();
    }
  }

  /**
   * Handle stats from engine
   */
  private handleStats(message: StatsMessage): void {
    // Could use for additional metrics
    logger.debug('Engine stats received', {
      requests: message.total_requests,
      success: message.success_requests,
      proxies: message.active_proxies,
    });
  }

  /**
   * Handle queue drained
   */
  private handleQueueDrained(): void {
    if (this.state !== 'running') {
      return;
    }

    this.state = 'completed';
    this.stopTimers();

    const stats = this.getStats();
    this.emit('complete', stats);
    logger.info('Scheduler completed', stats);
  }

  /**
   * Record result for success rate tracking
   */
  private recordResult(success: boolean): void {
    const now = Date.now();
    this.recentResults.push({ success, timestamp: now });

    // Keep only last 100 results
    if (this.recentResults.length > 100) {
      this.recentResults.shift();
    }
  }

  /**
   * Get recent success rate
   */
  private getRecentSuccessRate(): number {
    if (this.recentResults.length === 0) {
      return 100;
    }

    const successCount = this.recentResults.filter(r => r.success).length;
    return (successCount / this.recentResults.length) * 100;
  }

  /**
   * Adjust concurrency based on success rate
   */
  private adjustConcurrency(): void {
    const successRate = this.getRecentSuccessRate();
    const target = this.options.targetSuccessRate;

    if (successRate >= target + 5 && this.currentConcurrency < this.options.maxConcurrency) {
      // Increase concurrency
      this.currentConcurrency = Math.min(
        this.currentConcurrency + 5,
        this.options.maxConcurrency
      );
      this.queue.setMaxConcurrent(this.currentConcurrency);
      logger.debug('Increased concurrency', { to: this.currentConcurrency, successRate });
    }
  }

  /**
   * Reduce concurrency (on blocks/errors)
   */
  private reduceConcurrency(): void {
    if (this.currentConcurrency > this.options.minConcurrency) {
      this.currentConcurrency = Math.max(
        this.currentConcurrency - 10,
        this.options.minConcurrency
      );
      this.queue.setMaxConcurrent(this.currentConcurrency);
      logger.debug('Reduced concurrency', { to: this.currentConcurrency });
    }
  }

  /**
   * Start stats timer
   */
  private startStatsTimer(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
    }

    this.statsTimer = setInterval(() => {
      const stats = this.getStats();
      this.emit('progress', stats);
    }, this.options.statsInterval);
  }

  /**
   * Stop all timers
   */
  private stopTimers(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
  }

  /**
   * Reset scheduler state
   */
  private reset(): void {
    this.queue.clearAll();
    this.urlSet.clear();
    this.allUrls = [];
    this.recentResults = [];
    this.captchaCount = 0;
    this.blockCount = 0;
    this.totalDorks = 0;
    this.startTime = null;
    this.currentConcurrency = this.options.initialConcurrency;
  }

  /**
   * Get current statistics
   */
  getStats(): SchedulerStats {
    const queueStats = this.queue.getStats();
    const elapsed = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const elapsedMin = elapsed / 60000;

    const requestsPerMin = elapsedMin > 0 ? queueStats.completed / elapsedMin : 0;
    const urlsPerMin = elapsedMin > 0 ? this.allUrls.length / elapsedMin : 0;

    // Calculate ETA
    let eta = 'Calculating...';
    if (requestsPerMin > 0 && queueStats.pending > 0) {
      const remainingMin = queueStats.pending / requestsPerMin;
      if (remainingMin < 60) {
        eta = `${Math.ceil(remainingMin)}m`;
      } else {
        const hours = Math.floor(remainingMin / 60);
        const mins = Math.ceil(remainingMin % 60);
        eta = `${hours}h ${mins}m`;
      }
    } else if (queueStats.pending === 0) {
      eta = 'Complete';
    }

    return {
      state: this.state,
      startTime: this.startTime || new Date(),
      elapsed,
      totalDorks: this.totalDorks,
      completedDorks: queueStats.completed,
      failedDorks: queueStats.failed,
      pendingDorks: queueStats.pending,
      runningTasks: queueStats.running,
      totalUrls: this.allUrls.length,
      uniqueUrls: this.urlSet.size,
      requestsPerMin: Math.round(requestsPerMin * 10) / 10,
      urlsPerMin: Math.round(urlsPerMin * 10) / 10,
      successRate: Math.round(queueStats.successRate * 10) / 10,
      eta,
      currentConcurrency: this.currentConcurrency,
      activeProxies: 0, // Updated from engine stats
      captchaCount: this.captchaCount,
      blockCount: this.blockCount,
    };
  }

  /**
   * Get current state
   */
  getState(): SchedulerState {
    return this.state;
  }

  /**
   * Get all URLs collected
   */
  getUrls(): string[] {
    return [...this.allUrls];
  }

  /**
   * Get unique URLs collected
   */
  getUniqueUrls(): string[] {
    return [...this.urlSet];
  }

  /**
   * Get failed dorks
   */
  getFailedDorks(): string[] {
    return this.queue.getFailedDorks();
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Check if completed
   */
  isCompleted(): boolean {
    return this.state === 'completed';
  }

  /**
   * Export state for resume
   */
  exportState(): object {
    return {
      stats: this.getStats(),
      queue: this.queue.exportState(),
      urls: this.allUrls,
    };
  }
}

// Singleton instance
let schedulerInstance: Scheduler | null = null;

/**
 * Get or create scheduler instance
 */
export function getScheduler(options?: SchedulerOptions): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler(options);
  }
  return schedulerInstance;
}

/**
 * Reset scheduler instance
 */
export async function resetScheduler(): Promise<void> {
  if (schedulerInstance) {
    await schedulerInstance.stop();
    schedulerInstance = null;
  }
}

export default Scheduler;
