/**
 * State Manager
 * Handles session persistence and resume functionality
 */

import fs from 'fs';
import path from 'path';
import { getLogger } from '../utils/logger.js';
import type { SavedState } from '../types/index.js';

const logger = getLogger();

// State file location
const DEFAULT_STATE_DIR = './state';
const STATE_FILE = 'session.json';

export interface StateConfig {
  stateDir: string;
  autoSaveInterval: number;
  maxBackups: number;
}

const DEFAULT_CONFIG: StateConfig = {
  stateDir: DEFAULT_STATE_DIR,
  autoSaveInterval: 30000, // 30 seconds
  maxBackups: 5,
};

export class StateManager {
  private config: StateConfig;
  private state: SavedState;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private dirty: boolean = false;

  constructor(config: Partial<StateConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.createEmptyState();
    this.ensureStateDir();
  }

  /**
   * Create empty state
   */
  private createEmptyState(): SavedState {
    return {
      sessionId: this.generateSessionId(),
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      config: {
        pagesPerDork: 5,
        workers: 100,
        engine: 'google',
      },
      progress: {
        completedDorks: [],
        pendingDorks: [],
        failedDorks: [],
        currentDork: null,
        currentPage: 0,
      },
      stats: {
        totalUrls: 0,
        uniqueUrls: 0,
        uniqueDomains: 0,
        requestCount: 0,
        errorCount: 0,
        blockCount: 0,
        captchaCount: 0,
      },
      output: {
        directory: './output',
        files: [],
      },
    };
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}-${random}`;
  }

  /**
   * Ensure state directory exists
   */
  private ensureStateDir(): void {
    if (!fs.existsSync(this.config.stateDir)) {
      fs.mkdirSync(this.config.stateDir, { recursive: true });
    }
  }

  /**
   * Get state file path
   */
  private getStatePath(): string {
    return path.join(this.config.stateDir, STATE_FILE);
  }

  /**
   * Get backup path
   */
  private getBackupPath(index: number): string {
    return path.join(this.config.stateDir, `session.backup.${index}.json`);
  }

  /**
   * Save state to disk
   */
  save(): void {
    try {
      this.state.lastUpdate = new Date().toISOString();
      const statePath = this.getStatePath();

      // Create backup of existing state
      if (fs.existsSync(statePath)) {
        this.rotateBackups();
        fs.copyFileSync(statePath, this.getBackupPath(0));
      }

      // Write new state
      fs.writeFileSync(statePath, JSON.stringify(this.state, null, 2));
      this.dirty = false;

      logger.debug('State saved', { sessionId: this.state.sessionId });
    } catch (error) {
      logger.error('Failed to save state', { error });
    }
  }

  /**
   * Rotate backup files
   */
  private rotateBackups(): void {
    for (let i = this.config.maxBackups - 1; i > 0; i--) {
      const current = this.getBackupPath(i - 1);
      const next = this.getBackupPath(i);
      if (fs.existsSync(current)) {
        fs.renameSync(current, next);
      }
    }
  }

  /**
   * Load state from disk
   */
  load(): boolean {
    try {
      const statePath = this.getStatePath();

      if (!fs.existsSync(statePath)) {
        logger.debug('No existing state found');
        return false;
      }

      const content = fs.readFileSync(statePath, 'utf-8');
      this.state = JSON.parse(content) as SavedState;

      logger.info('State loaded', {
        sessionId: this.state.sessionId,
        completed: this.state.progress.completedDorks.length,
        pending: this.state.progress.pendingDorks.length,
      });

      return true;
    } catch (error) {
      logger.error('Failed to load state', { error });
      return false;
    }
  }

  /**
   * Check if resumable state exists
   */
  canResume(): boolean {
    const statePath = this.getStatePath();
    if (!fs.existsSync(statePath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(statePath, 'utf-8');
      const state = JSON.parse(content) as SavedState;
      return state.progress.pendingDorks.length > 0 || state.progress.failedDorks.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get resume info without loading full state
   */
  getResumeInfo(): {
    sessionId: string;
    lastUpdate: string;
    completed: number;
    pending: number;
    failed: number;
    urls: number;
  } | null {
    try {
      const statePath = this.getStatePath();
      if (!fs.existsSync(statePath)) {
        return null;
      }

      const content = fs.readFileSync(statePath, 'utf-8');
      const state = JSON.parse(content) as SavedState;

      return {
        sessionId: state.sessionId,
        lastUpdate: state.lastUpdate,
        completed: state.progress.completedDorks.length,
        pending: state.progress.pendingDorks.length,
        failed: state.progress.failedDorks.length,
        urls: state.stats.totalUrls,
      };
    } catch {
      return null;
    }
  }

  /**
   * Clear state
   */
  clear(): void {
    this.state = this.createEmptyState();
    const statePath = this.getStatePath();
    
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }

    // Clear backups
    for (let i = 0; i < this.config.maxBackups; i++) {
      const backup = this.getBackupPath(i);
      if (fs.existsSync(backup)) {
        fs.unlinkSync(backup);
      }
    }

    logger.info('State cleared');
  }

  /**
   * Start auto-save
   */
  startAutoSave(): void {
    if (this.autoSaveTimer) {
      return;
    }

    this.autoSaveTimer = setInterval(() => {
      if (this.dirty) {
        this.save();
      }
    }, this.config.autoSaveInterval);

    logger.debug('Auto-save started', { interval: this.config.autoSaveInterval });
  }

  /**
   * Stop auto-save
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }

    // Final save
    if (this.dirty) {
      this.save();
    }

    logger.debug('Auto-save stopped');
  }

  /**
   * Mark state as dirty (needs saving)
   */
  private markDirty(): void {
    this.dirty = true;
  }

  // ========== State Update Methods ==========

  /**
   * Set configuration
   */
  setConfig(config: Partial<SavedState['config']>): void {
    this.state.config = { ...this.state.config, ...config };
    this.markDirty();
  }

  /**
   * Set pending dorks
   */
  setPendingDorks(dorks: string[]): void {
    this.state.progress.pendingDorks = [...dorks];
    this.markDirty();
  }

  /**
   * Add completed dork
   */
  addCompletedDork(dork: string): void {
    // Remove from pending
    const pendingIndex = this.state.progress.pendingDorks.indexOf(dork);
    if (pendingIndex !== -1) {
      this.state.progress.pendingDorks.splice(pendingIndex, 1);
    }

    // Remove from failed if present
    const failedIndex = this.state.progress.failedDorks.indexOf(dork);
    if (failedIndex !== -1) {
      this.state.progress.failedDorks.splice(failedIndex, 1);
    }

    // Add to completed
    if (!this.state.progress.completedDorks.includes(dork)) {
      this.state.progress.completedDorks.push(dork);
    }

    this.markDirty();
  }

  /**
   * Add failed dork
   */
  addFailedDork(dork: string): void {
    // Remove from pending
    const pendingIndex = this.state.progress.pendingDorks.indexOf(dork);
    if (pendingIndex !== -1) {
      this.state.progress.pendingDorks.splice(pendingIndex, 1);
    }

    // Add to failed
    if (!this.state.progress.failedDorks.includes(dork)) {
      this.state.progress.failedDorks.push(dork);
    }

    this.markDirty();
  }

  /**
   * Set current dork being processed
   */
  setCurrentDork(dork: string | null, page: number = 0): void {
    this.state.progress.currentDork = dork;
    this.state.progress.currentPage = page;
    this.markDirty();
  }

  /**
   * Update statistics
   */
  updateStats(stats: Partial<SavedState['stats']>): void {
    this.state.stats = { ...this.state.stats, ...stats };
    this.markDirty();
  }

  /**
   * Increment stat counter
   */
  incrementStat(key: keyof SavedState['stats'], amount: number = 1): void {
    (this.state.stats[key] as number) += amount;
    this.markDirty();
  }

  /**
   * Update output info
   */
  updateOutput(output: Partial<SavedState['output']>): void {
    this.state.output = { ...this.state.output, ...output };
    this.markDirty();
  }

  /**
   * Add output file
   */
  addOutputFile(file: string): void {
    if (!this.state.output.files.includes(file)) {
      this.state.output.files.push(file);
      this.markDirty();
    }
  }

  // ========== State Getter Methods ==========

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.state.sessionId;
  }

  /**
   * Get full state
   */
  getState(): SavedState {
    return { ...this.state };
  }

  /**
   * Get pending dorks
   */
  getPendingDorks(): string[] {
    return [...this.state.progress.pendingDorks];
  }

  /**
   * Get completed dorks
   */
  getCompletedDorks(): string[] {
    return [...this.state.progress.completedDorks];
  }

  /**
   * Get failed dorks
   */
  getFailedDorks(): string[] {
    return [...this.state.progress.failedDorks];
  }

  /**
   * Get statistics
   */
  getStats(): SavedState['stats'] {
    return { ...this.state.stats };
  }

  /**
   * Get progress summary
   */
  getProgressSummary(): {
    completed: number;
    pending: number;
    failed: number;
    total: number;
    percent: number;
  } {
    const completed = this.state.progress.completedDorks.length;
    const pending = this.state.progress.pendingDorks.length;
    const failed = this.state.progress.failedDorks.length;
    const total = completed + pending + failed;

    return {
      completed,
      pending,
      failed,
      total,
      percent: total > 0 ? (completed / total) * 100 : 0,
    };
  }
}

// Singleton instance
let stateManagerInstance: StateManager | null = null;

export function getStateManager(config?: Partial<StateConfig>): StateManager {
  if (!stateManagerInstance) {
    stateManagerInstance = new StateManager(config);
  }
  return stateManagerInstance;
}

export function resetStateManager(): void {
  if (stateManagerInstance) {
    stateManagerInstance.stopAutoSave();
    stateManagerInstance = null;
  }
}

export default StateManager;
