/**
 * Task Queue
 * Manages dork processing queue with priority, retry, and state tracking
 */

import { EventEmitter } from 'events';
import { nanoid } from 'nanoid';
import type { Task, TaskQueue as TaskQueueType } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Task priority levels
export enum TaskPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3,
}

// Task with priority
interface PriorityTask extends Task {
  priority: TaskPriority;
  maxRetries: number;
}

// Queue events
export interface TaskQueueEvents {
  taskAdded: (task: Task) => void;
  taskStarted: (task: Task) => void;
  taskCompleted: (task: Task) => void;
  taskFailed: (task: Task, error: string) => void;
  taskRetry: (task: Task, attempt: number) => void;
  queueEmpty: () => void;
  queueDrained: () => void;
}

export class TaskQueue extends EventEmitter {
  private pending: PriorityTask[] = [];
  private running: Map<string, PriorityTask> = new Map();
  private completed: PriorityTask[] = [];
  private failed: PriorityTask[] = [];
  private maxConcurrent: number;
  private maxRetries: number;
  private paused: boolean = false;
  private processedDorks: Set<string> = new Set();
  private pagesPerDork: number;

  constructor(options: {
    maxConcurrent?: number;
    maxRetries?: number;
    pagesPerDork?: number;
  } = {}) {
    super();
    this.maxConcurrent = options.maxConcurrent || 100;
    this.maxRetries = options.maxRetries || 3;
    this.pagesPerDork = options.pagesPerDork || 5;
  }

  /**
   * Add a single dork to the queue
   */
  addDork(dork: string, priority: TaskPriority = TaskPriority.NORMAL): string {
    const taskId = nanoid();
    
    const task: PriorityTask = {
      id: taskId,
      dork: dork.trim(),
      page: 0,
      status: 'pending',
      priority,
      maxRetries: this.maxRetries,
      retryCount: 0,
      createdAt: new Date(),
      urls: [],
    };

    this.insertByPriority(task);
    this.emit('taskAdded', task);
    logger.debug('Task added', { taskId, dork: task.dork });

    return taskId;
  }

  /**
   * Add multiple dorks to the queue
   */
  addDorks(dorks: string[], priority: TaskPriority = TaskPriority.NORMAL): string[] {
    const taskIds: string[] = [];

    for (const dork of dorks) {
      const trimmed = dork.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        taskIds.push(this.addDork(trimmed, priority));
      }
    }

    logger.info('Dorks added to queue', { count: taskIds.length });
    return taskIds;
  }

  /**
   * Add a page task (for pagination)
   */
  addPageTask(dork: string, page: number, priority: TaskPriority = TaskPriority.HIGH): string {
    const taskId = nanoid();

    const task: PriorityTask = {
      id: taskId,
      dork: dork.trim(),
      page,
      status: 'pending',
      priority,
      maxRetries: this.maxRetries,
      retryCount: 0,
      createdAt: new Date(),
      urls: [],
    };

    // Insert at front for same priority (prioritize pagination)
    this.insertByPriority(task, true);
    this.emit('taskAdded', task);

    return taskId;
  }

  /**
   * Insert task by priority
   */
  private insertByPriority(task: PriorityTask, front: boolean = false): void {
    if (this.pending.length === 0) {
      this.pending.push(task);
      return;
    }

    // Find insertion point
    let insertIndex = this.pending.length;
    for (let i = 0; i < this.pending.length; i++) {
      if (front) {
        if (this.pending[i].priority < task.priority) {
          insertIndex = i;
          break;
        }
      } else {
        if (this.pending[i].priority < task.priority) {
          insertIndex = i;
          break;
        }
      }
    }

    this.pending.splice(insertIndex, 0, task);
  }

  /**
   * Get next task to process
   */
  getNext(): Task | null {
    if (this.paused) {
      return null;
    }

    if (this.running.size >= this.maxConcurrent) {
      return null;
    }

    if (this.pending.length === 0) {
      return null;
    }

    const task = this.pending.shift()!;
    task.status = 'running';
    task.startedAt = new Date();
    
    this.running.set(task.id, task);
    this.emit('taskStarted', task);

    return task;
  }

  /**
   * Get multiple next tasks
   */
  getNextBatch(count: number): Task[] {
    const tasks: Task[] = [];
    
    for (let i = 0; i < count; i++) {
      const task = this.getNext();
      if (!task) break;
      tasks.push(task);
    }

    return tasks;
  }

  /**
   * Mark task as completed
   */
  complete(taskId: string, urls: string[] = [], hasNextPage: boolean = false): void {
    const task = this.running.get(taskId);
    if (!task) {
      logger.warn('Task not found for completion', { taskId });
      return;
    }

    task.status = 'completed';
    task.completedAt = new Date();
    task.urls = urls;

    this.running.delete(taskId);
    this.completed.push(task);

    // Track processed dork
    const dorkKey = `${task.dork}:${task.page}`;
    this.processedDorks.add(dorkKey);

    this.emit('taskCompleted', task);
    logger.taskComplete(taskId, urls.length, Date.now() - task.startedAt!.getTime());

    // Add next page task if needed
    if (hasNextPage && task.page < this.pagesPerDork - 1) {
      this.addPageTask(task.dork, task.page + 1);
    }

    this.checkQueueState();
  }

  /**
   * Mark task as failed
   */
  fail(taskId: string, error: string, retry: boolean = true): void {
    const task = this.running.get(taskId);
    if (!task) {
      logger.warn('Task not found for failure', { taskId });
      return;
    }

    task.error = error;

    // Check if should retry
    if (retry && task.retryCount < task.maxRetries) {
      task.retryCount++;
      task.status = 'pending';
      task.startedAt = undefined;
      
      this.running.delete(taskId);
      
      // Add back to queue with higher priority
      task.priority = Math.min(task.priority + 1, TaskPriority.CRITICAL);
      this.insertByPriority(task);
      
      this.emit('taskRetry', task, task.retryCount);
      logger.debug('Task queued for retry', { taskId, attempt: task.retryCount });
    } else {
      task.status = 'failed';
      task.completedAt = new Date();
      
      this.running.delete(taskId);
      this.failed.push(task);
      
      this.emit('taskFailed', task, error);
      logger.taskFailed(taskId, error);
    }

    this.checkQueueState();
  }

  /**
   * Mark task as blocked (CAPTCHA, rate limit, etc.)
   */
  block(taskId: string, reason: string): void {
    // Blocked tasks get retried with delay
    this.fail(taskId, `Blocked: ${reason}`, true);
  }

  /**
   * Check queue state and emit events
   */
  private checkQueueState(): void {
    if (this.pending.length === 0 && this.running.size === 0) {
      this.emit('queueDrained');
    } else if (this.pending.length === 0) {
      this.emit('queueEmpty');
    }
  }

  /**
   * Pause queue processing
   */
  pause(): void {
    this.paused = true;
    logger.info('Queue paused');
  }

  /**
   * Resume queue processing
   */
  resume(): void {
    this.paused = false;
    logger.info('Queue resumed');
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Clear all pending tasks
   */
  clearPending(): void {
    this.pending = [];
    logger.info('Pending queue cleared');
  }

  /**
   * Clear all queues
   */
  clearAll(): void {
    this.pending = [];
    this.running.clear();
    this.completed = [];
    this.failed = [];
    this.processedDorks.clear();
    logger.info('All queues cleared');
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    pending: number;
    running: number;
    completed: number;
    failed: number;
    total: number;
    successRate: number;
    urlsFound: number;
  } {
    const totalUrls = this.completed.reduce((sum, t) => sum + t.urls.length, 0);
    const totalProcessed = this.completed.length + this.failed.length;
    
    return {
      pending: this.pending.length,
      running: this.running.size,
      completed: this.completed.length,
      failed: this.failed.length,
      total: this.pending.length + this.running.size + this.completed.length + this.failed.length,
      successRate: totalProcessed > 0 ? (this.completed.length / totalProcessed) * 100 : 0,
      urlsFound: totalUrls,
    };
  }

  /**
   * Get queue state
   */
  getState(): TaskQueueType {
    return {
      pending: [...this.pending],
      running: Array.from(this.running.values()),
      completed: [...this.completed],
      failed: [...this.failed],
    };
  }

  /**
   * Get all URLs found
   */
  getAllUrls(): string[] {
    const urls: string[] = [];
    for (const task of this.completed) {
      urls.push(...task.urls);
    }
    return urls;
  }

  /**
   * Get unique URLs found
   */
  getUniqueUrls(): string[] {
    return [...new Set(this.getAllUrls())];
  }

  /**
   * Get failed dorks
   */
  getFailedDorks(): string[] {
    return this.failed.map(t => t.dork);
  }

  /**
   * Get pending count
   */
  getPendingCount(): number {
    return this.pending.length;
  }

  /**
   * Get running count
   */
  getRunningCount(): number {
    return this.running.size;
  }

  /**
   * Check if has pending tasks
   */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Check if has running tasks
   */
  hasRunning(): boolean {
    return this.running.size > 0;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.pending.length === 0 && this.running.size === 0;
  }

  /**
   * Check if dork was already processed
   */
  isProcessed(dork: string, page: number = 0): boolean {
    return this.processedDorks.has(`${dork}:${page}`);
  }

  /**
   * Set max concurrent tasks
   */
  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
  }

  /**
   * Set max retries
   */
  setMaxRetries(max: number): void {
    this.maxRetries = max;
  }

  /**
   * Set pages per dork
   */
  setPagesPerDork(pages: number): void {
    this.pagesPerDork = pages;
  }

  /**
   * Export state for resume capability
   */
  exportState(): {
    pending: Array<{ dork: string; page: number }>;
    failed: Array<{ dork: string; page: number; error: string }>;
    completed: Array<{ dork: string; page: number; urlCount: number }>;
  } {
    return {
      pending: this.pending.map(t => ({ dork: t.dork, page: t.page })),
      failed: this.failed.map(t => ({ dork: t.dork, page: t.page, error: t.error || 'Unknown' })),
      completed: this.completed.map(t => ({ dork: t.dork, page: t.page, urlCount: t.urls.length })),
    };
  }

  /**
   * Import state for resume
   */
  importState(state: {
    pending?: Array<{ dork: string; page: number }>;
    processedDorks?: string[];
  }): void {
    if (state.pending) {
      for (const item of state.pending) {
        if (item.page === 0) {
          this.addDork(item.dork);
        } else {
          this.addPageTask(item.dork, item.page);
        }
      }
    }

    if (state.processedDorks) {
      for (const dork of state.processedDorks) {
        this.processedDorks.add(dork);
      }
    }
  }
}

// Singleton instance
let queueInstance: TaskQueue | null = null;

/**
 * Get or create queue instance
 */
export function getTaskQueue(options?: {
  maxConcurrent?: number;
  maxRetries?: number;
  pagesPerDork?: number;
}): TaskQueue {
  if (!queueInstance) {
    queueInstance = new TaskQueue(options);
  }
  return queueInstance;
}

/**
 * Reset queue instance
 */
export function resetTaskQueue(): void {
  if (queueInstance) {
    queueInstance.clearAll();
    queueInstance = null;
  }
}

export default TaskQueue;
