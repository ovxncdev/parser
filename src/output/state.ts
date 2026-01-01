/**
 * State Manager
 * Save and restore progress for resume capability
 */

import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import type { SavedState, OutputStats, Task } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// State file version for compatibility
const STATE_VERSION = '1.0.0';

// State manager options
export interface StateManagerOptions {
  stateFile: string;
  autoSave: boolean;
  saveInterval: number;
}

const DEFAULT_OPTIONS: StateManagerOptions = {
  stateFile: './state/progress.json',
  autoSave: true,
  saveInterval: 30000, // 30 seconds
};

// Full state object
export interface FullState {
  version: string;
  timestamp: string;
  session: {
    id: string;
    startTime: string;
    lastUpdate: string;
  };
  progress: {
    completedDorks: string[];
    pendingDorks: string[];
    failedDorks: Array<{ dork: string; error: string; attempts: number }>;
    currentDork: string | null;
    currentPage: number;
  };
  stats: {
    totalDorks: number;
    completedCount: number;
    failedCount: number;
    totalUrls: number;
    uniqueUrls: number;
    uniqueDomains: number;
    startTime: string;
    elapsedMs: number;
    requestsPerMin: number;
    urlsPerMin: number;
  };
  proxies: {
    total: number;
    alive: number;
    dead: number;
    quarantined: string[];
  };
  output: {
    directory: string;
    files: string[];
    urlCount: number;
  };
  config: {
    pagesPerDork: number;
    workers: number;
    engine: string;
  };
}

/**
 * State Manager for saving and restoring progress
 */
export class StateManager {
  private options: StateManagerOptions;
  private state: FullState;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty: boolean = false;
  private sessionId: string;

  constructor(options: Partial<StateManagerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.sessionId = this.generateSessionId();
    this.state = this.createEmptyState();

    // Ensure state directory exists
    const stateDir = path.dirname(this.options.stateFile);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    logger.debug('StateManager initialized', {
      stateFile: this.options.stateFile,
      sessionId: this.sessionId,
    });
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `session_${dayjs().format('YYYYMMDD_HHmmss')}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Create empty state object
   */
  private createEmptyState(): FullState {
    const now = new Date().toISOString();
    return {
      version: STATE_VERSION,
      timestamp: now,
      session: {
        id: this.sessionId,
        startTime: now,
        lastUpdate: now,
      },
      progress: {
        completedDorks: [],
        pendingDorks: [],
        failedDorks: [],
        currentDork: null,
        currentPage: 0,
      },
      stats: {
        totalDorks: 0,
        completedCount: 0,
        failedCount: 0,
        totalUrls: 0,
        uniqueUrls: 0,
        uniqueDomains: 0,
        startTime: now,
        elapsedMs: 0,
        requestsPerMin: 0,
        urlsPerMin: 0,
      },
      proxies: {
        total: 0,
        alive: 0,
        dead: 0,
        quarantined: [],
      },
      output: {
        directory: '',
        files: [],
        urlCount: 0,
      },
      config: {
        pagesPerDork: 5,
        workers: 100,
        engine: 'google',
      },
    };
  }

  /**
   * Start auto-save timer
   */
  startAutoSave(): void {
    if (!this.options.autoSave) return;

    this.stopAutoSave();
    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.save();
      }
    }, this.options.saveInterval);

    logger.debug('Auto-save started', { interval: this.options.saveInterval });
  }

  /**
   * Stop auto-save timer
   */
  stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * Mark state as dirty (needs saving)
   */
  markDirty(): void {
    this.dirty = true;
    this.state.session.lastUpdate = new Date().toISOString();
    this.state.timestamp = this.state.session.lastUpdate;
  }

  /**
   * Update progress
   */
  updateProgress(update: Partial<FullState['progress']>): void {
    Object.assign(this.state.progress, update);
    this.markDirty();
  }

  /**
   * Add completed dork
   */
  addCompletedDork(dork: string): void {
    if (!this.state.progress.completedDorks.includes(dork)) {
      this.state.progress.completedDorks.push(dork);
      this.state.stats.completedCount++;
      
      // Remove from pending
      const pendingIdx = this.state.progress.pendingDorks.indexOf(dork);
      if (pendingIdx !== -1) {
        this.state.progress.pendingDorks.splice(pendingIdx, 1);
      }
      
      this.markDirty();
    }
  }

  /**
   * Add failed dork
   */
  addFailedDork(dork: string, error: string): void {
    const existing = this.state.progress.failedDorks.find(f => f.dork === dork);
    if (existing) {
      existing.attempts++;
      existing.error = error;
    } else {
      this.state.progress.failedDorks.push({ dork, error, attempts: 1 });
      this.state.stats.failedCount++;
    }
    
    // Remove from pending
    const pendingIdx = this.state.progress.pendingDorks.indexOf(dork);
    if (pendingIdx !== -1) {
      this.state.progress.pendingDorks.splice(pendingIdx, 1);
    }
    
    this.markDirty();
  }

  /**
   * Set pending dorks
   */
  setPendingDorks(dorks: string[]): void {
    this.state.progress.pendingDorks = [...dorks];
    this.state.stats.totalDorks = dorks.length;
    this.markDirty();
  }

  /**
   * Update stats
   */
  updateStats(update: Partial<FullState['stats']>): void {
    Object.assign(this.state.stats, update);
    this.markDirty();
  }

  /**
   * Update proxy stats
   */
  updateProxies(update: Partial<FullState['proxies']>): void {
    Object.assign(this.state.proxies, update);
    this.markDirty();
  }

  /**
   * Update output info
   */
  updateOutput(update: Partial<FullState['output']>): void {
    Object.assign(this.state.output, update);
    this.markDirty();
  }

  /**
   * Set config
   */
  setConfig(config: Partial<FullState['config']>): void {
    Object.assign(this.state.config, config);
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
   * Save state to file
   */
  save(): boolean {
    try {
      // Update timestamp
      this.state.timestamp = new Date().toISOString();
      this.state.session.lastUpdate = this.state.timestamp;

      // Calculate elapsed time
      const startTime = new Date(this.state.stats.startTime).getTime();
      this.state.stats.elapsedMs = Date.now() - startTime;

      // Write to file
      const stateJson = JSON.stringify(this.state, null, 2);
      fs.writeFileSync(this.options.stateFile, stateJson, 'utf8');

      this.dirty = false;
      logger.debug('State saved', { file: this.options.stateFile });
      return true;
    } catch (error) {
      logger.error('Failed to save state', { error });
      return false;
    }
  }

  /**
   * Load state from file
   */
  load(): boolean {
    try {
      if (!fs.existsSync(this.options.stateFile)) {
        logger.debug('No state file found', { file: this.options.stateFile });
        return false;
      }

      const stateJson = fs.readFileSync(this.options.stateFile, 'utf8');
      const loadedState = JSON.parse(stateJson) as FullState;

      // Version check
      if (loadedState.version !== STATE_VERSION) {
        logger.warn('State version mismatch', {
          expected: STATE_VERSION,
          found: loadedState.version,
        });
        // Could add migration logic here
      }

      this.state = loadedState;
      this.sessionId = loadedState.session.id;
      this.dirty = false;

      logger.info('State loaded', {
        sessionId: this.sessionId,
        completed: this.state.stats.completedCount,
        pending: this.state.progress.pendingDorks.length,
        failed: this.state.stats.failedCount,
      });

      return true;
    } catch (error) {
      logger.error('Failed to load state', { error });
      return false;
    }
  }

  /**
   * Check if resume is available
   */
  canResume(): boolean {
    if (!fs.existsSync(this.options.stateFile)) {
      return false;
    }

    try {
      const stateJson = fs.readFileSync(this.options.stateFile, 'utf8');
      const state = JSON.parse(stateJson) as FullState;

      // Check if there are pending dorks
      return state.progress.pendingDorks.length > 0 ||
             state.progress.currentDork !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get resume info
   */
  getResumeInfo(): {
    available: boolean;
    sessionId: string;
    lastUpdate: string;
    completed: number;
    pending: number;
    failed: number;
    urls: number;
  } | null {
    if (!this.canResume()) {
      return null;
    }

    try {
      const stateJson = fs.readFileSync(this.options.stateFile, 'utf8');
      const state = JSON.parse(stateJson) as FullState;

      return {
        available: true,
        sessionId: state.session.id,
        lastUpdate: state.session.lastUpdate,
        completed: state.stats.completedCount,
        pending: state.progress.pendingDorks.length,
        failed: state.stats.failedCount,
        urls: state.stats.totalUrls,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get dorks to resume
   */
  getDorksToResume(): string[] {
    const dorks: string[] = [];

    // Add current dork if any
    if (this.state.progress.currentDork) {
      dorks.push(this.state.progress.currentDork);
    }

    // Add pending dorks
    dorks.push(...this.state.progress.pendingDorks);

    // Optionally add failed dorks with low attempt count
    const retryableFailed = this.state.progress.failedDorks
      .filter(f => f.attempts < 3)
      .map(f => f.dork);
    dorks.push(...retryableFailed);

    return [...new Set(dorks)]; // Deduplicate
  }

  /**
   * Get completed dorks (for skipping)
   */
  getCompletedDorks(): Set<string> {
    return new Set(this.state.progress.completedDorks);
  }

  /**
   * Get current state
   */
  getState(): FullState {
    return { ...this.state };
  }

  /**
   * Get stats
   */
  getStats(): FullState['stats'] {
    return { ...this.state.stats };
  }

  /**
   * Clear state file
   */
  clear(): void {
    this.state = this.createEmptyState();
    this.dirty = false;

    if (fs.existsSync(this.options.stateFile)) {
      fs.unlinkSync(this.options.stateFile);
      logger.info('State file cleared');
    }
  }

  /**
   * Create backup of current state
   */
  backup(): string | null {
    if (!fs.existsSync(this.options.stateFile)) {
      return null;
    }

    try {
      const backupDir = path.join(path.dirname(this.options.stateFile), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });

      const timestamp = dayjs().format('YYYYMMDD_HHmmss');
      const backupFile = path.join(backupDir, `progress_${timestamp}.json`);

      fs.copyFileSync(this.options.stateFile, backupFile);
      logger.info('State backup created', { file: backupFile });

      return backupFile;
    } catch (error) {
      logger.error('Failed to create backup', { error });
      return null;
    }
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.stopAutoSave();
    if (this.dirty) {
      this.save();
    }
  }

  /**
   * Convert to legacy SavedState format
   */
  toLegacyFormat(): SavedState {
    return {
      version: this.state.version,
      timestamp: new Date(this.state.timestamp),
      completedDorks: this.state.progress.completedDorks,
      pendingDorks: this.state.progress.pendingDorks,
      failedDorks: this.state.progress.failedDorks.map(f => f.dork),
      stats: {
        totalDorks: this.state.stats.totalDorks,
        completedDorks: this.state.stats.completedCount,
        totalPages: 0,
        totalUrls: this.state.stats.totalUrls,
        uniqueUrls: this.state.stats.uniqueUrls,
        uniqueDomains: this.state.stats.uniqueDomains,
        filteredUrls: 0,
        startTime: new Date(this.state.stats.startTime),
        endTime: undefined,
        duration: this.state.stats.elapsedMs,
        requestsPerMin: this.state.stats.requestsPerMin,
        urlsPerMin: this.state.stats.urlsPerMin,
        successRate: 0,
      },
      lastProxy: '',
      lastDork: this.state.progress.currentDork || '',
    };
  }
}

// Singleton instance
let stateManagerInstance: StateManager | null = null;

/**
 * Get or create state manager
 */
export function getStateManager(options?: Partial<StateManagerOptions>): StateManager {
  if (!stateManagerInstance) {
    stateManagerInstance = new StateManager(options);
  }
  return stateManagerInstance;
}

/**
 * Reset state manager
 */
export function resetStateManager(): void {
  if (stateManagerInstance) {
    stateManagerInstance.cleanup();
    stateManagerInstance = null;
  }
}

export default StateManager;
