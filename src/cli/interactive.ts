#!/usr/bin/env node

/**
 * Google Dork Parser
 * High-performance dork scraper with hybrid Go/TypeScript architecture
 * 
 * @author 
 * @version 1.0.0
 */

import { createProgram } from './cli/commands.js';
import { getLogger, resetLogger } from './utils/logger.js';
import { resetEngine } from './orchestrator/engine.js';
import { resetScheduler } from './orchestrator/scheduler.js';
import { resetTaskQueue } from './orchestrator/taskQueue.js';
import { resetFilterPipeline } from './filter/index.js';
import { resetOutputManager } from './output/writer.js';
import { resetStateManager } from './output/state.js';
import { resetBrowserFallback } from './browser/playwright.js';
import { resetUI } from './cli/ui.js';

// Initialize logger
const logger = getLogger({ level: 'info', console: true, file: true });

/**
 * Cleanup all resources
 */
async function cleanup(): Promise<void> {
  logger.info('Cleaning up resources...');

  try {
    // Stop scheduler first
    await resetScheduler();

    // Stop engine
    await resetEngine();

    // Reset other components
    resetTaskQueue();
    resetFilterPipeline();
    await resetOutputManager();
    resetStateManager();
    await resetBrowserFallback();
    resetUI();
    resetLogger();
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

/**
 * Handle uncaught errors
 */
function setupErrorHandlers(): void {
  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    await cleanup();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    logger.error('Unhandled rejection', { reason, promise });
    await cleanup();
    process.exit(1);
  });

  // Graceful shutdown handlers
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT');
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM');
    await cleanup();
    process.exit(0);
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  setupErrorHandlers();

  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    logger.error('Command failed', { error: (error as Error).message });
    await cleanup();
    process.exit(1);
  }
}

// Run
main().catch(async (error) => {
  console.error('Fatal error:', error);
  await cleanup();
  process.exit(1);
});

// Export for programmatic use
export {
  createProgram,
  cleanup,
};

export * from './types/index.js';
export * from './orchestrator/engine.js';
export * from './orchestrator/scheduler.js';
export * from './orchestrator/taskQueue.js';
export * from './filter/index.js';
export * from './output/writer.js';
export * from './output/state.js';
export * from './browser/playwright.js';
export * from './cli/ui.js';
export * from './cli/commands.js';
export * from './cli/interactive.js';
export * from './cli/dashboard.js';
export * from './utils/logger.js';
export * from './utils/validator.js';
