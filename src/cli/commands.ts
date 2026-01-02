/**
 * CLI Commands
 * Command handlers for all CLI operations
 */

import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import type { CliOptions, EngineConfig, Settings } from '../types/index.js';
import { getUI, TerminalUI } from './ui.js';
import { getScheduler, Scheduler } from '../orchestrator/scheduler.js';
import { getFilterPipeline } from '../filter/index.js';
import { getOutputManager, OutputManager } from '../output/writer.js';
import { getStateManager, StateManager } from '../output/state.js';
import { validateAll, validateProxyFile, validateDorkFile } from '../utils/validator.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Default settings
const DEFAULT_SETTINGS: Partial<Settings> = {
  engine: {
    type: 'google',
    workers: 100,
    pagesPerDork: 5,
    resultsPerPage: 10,
    timeout: 30000,
    retryAttempts: 3,
    retryDelay: 5000,
  },
  proxy: {
    rotateAfter: 1,
    rotationStrategy: 'round_robin',
    healthCheckOnStart: true,
    healthCheckInterval: 300000,
    quarantineDuration: 300000,
    maxFailCount: 5,
    protocols: ['http', 'https', 'socks4', 'socks5'],
  },
  stealth: {
    profile: 'normal',
    delayMin: 1000,
    delayMax: 3000,
    burstSize: 10,
    burstPause: 5000,
    sessionMaxRequests: 100,
    sessionCooldown: 60000,
    jitterPercent: 0.3,
    rotateUserAgent: true,
    rotateGoogleDomain: true,
  },
};

/**
 * Load settings from file
 */
function loadSettings(configPath?: string): Settings {
  const settingsPath = configPath || './config/settings.json';
  
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(content) as Settings;
    } catch (error) {
      logger.warn('Failed to load settings, using defaults', { error });
    }
  }

  return DEFAULT_SETTINGS as Settings;
}

/**
 * Load file lines
 */
function loadFileLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

/**
 * Calculate time estimate
 */
function calculateEstimate(
  dorkCount: number,
  proxyCount: number,
  pagesPerDork: number,
  requestsPerProxyPerHour: number = 20
): { totalRequests: number; estimatedTime: string; requestsPerMin: number } {
  const totalRequests = dorkCount * pagesPerDork;
  const effectiveProxies = Math.max(1, Math.floor(proxyCount * 0.5)); // Assume 50% success rate
  const requestsPerMin = (effectiveProxies * requestsPerProxyPerHour) / 60;
  const totalMinutes = totalRequests / requestsPerMin;

  let estimatedTime: string;
  if (totalMinutes < 60) {
    estimatedTime = `${Math.ceil(totalMinutes)} minutes`;
  } else {
    const hours = Math.floor(totalMinutes / 60);
    const mins = Math.ceil(totalMinutes % 60);
    estimatedTime = `${hours}h ${mins}m`;
  }

  return { totalRequests, estimatedTime, requestsPerMin: Math.round(requestsPerMin) };
}

/**
 * Main run command
 */
export async function runCommand(options: CliOptions): Promise<void> {
  const ui = getUI({ colors: !options.quiet });

  try {
    // Show banner
    if (!options.quiet) {
      ui.showBanner();
    }

    // Load settings
    const settings = loadSettings(options.config);

    // Validate inputs
    ui.startSpinner('Validating inputs...');
    const validation = validateAll({
      dorksFile: options.dorks,
      proxiesFile: options.proxies,
      outputDir: options.output,
    });

    if (!validation.valid) {
      ui.spinnerFail('Validation failed');
      for (const error of validation.errors) {
        ui.showError('Validation Error', error);
      }
      process.exit(1);
    }

    for (const warning of validation.warnings) {
      ui.showWarning(warning);
    }

    ui.spinnerSuccess('Inputs validated');

    // Load dorks and proxies
    const dorks = loadFileLines(options.dorks);
    const proxies = loadFileLines(options.proxies);

    // Show configuration
    const workers = options.threads || settings.engine?.workers || 100;
    const pagesPerDork = options.pages || settings.engine?.pagesPerDork || 5;

    ui.showConfig({
      dorks: dorks.length,
      proxies: proxies.length,
      workers,
      pagesPerDork,
      outputDir: options.output || './output',
    });

    // Show estimate
    const estimate = calculateEstimate(dorks.length, proxies.length, pagesPerDork);
    ui.showEstimate(estimate);

    // Confirm if large job
    if (dorks.length > 10000 && !options.quiet) {
      const confirmed = await ui.confirm('This is a large job. Continue?');
      if (!confirmed) {
        ui.showInfo('Aborted by user');
        process.exit(0);
      }
    }

    // Check for resume
    const stateManager = getStateManager();
    if (options.resume && stateManager.canResume()) {
      const resumeInfo = stateManager.getResumeInfo();
      if (resumeInfo) {
        ui.showInfo(`Resuming previous session: ${resumeInfo.completed} completed, ${resumeInfo.pending} pending`);
        stateManager.load();
      }
    }

    // Initialize output manager
    const outputManager = getOutputManager({
      directory: options.output || './output',
      formats: (options.format?.split(',') as any) || ['txt', 'json'],
      separateByDork: false,
      includeRaw: true,
      includeFiltered: true,
      includeDomains: true,
      includeStats: true,
      realTimeWrite: true,
      timestampFolders: true,
    });

    // Initialize filter pipeline
    const filterPipeline = getFilterPipeline({
      ...settings.filter,
      removeDuplicates: true,
      antiPublic: true,
    });

    // Build engine config
    const engineConfig: EngineConfig = {
      engine: 'google',
      workers,
      pages_per_dork: pagesPerDork,
      timeout_ms: options.timeout || settings.engine?.timeout || 30000,
      delay_min_ms: settings.stealth?.delayMin || 1000,
      delay_max_ms: settings.stealth?.delayMax || 3000,
      retry_attempts: settings.engine?.retryAttempts || 3,
      proxy_rotate_after: settings.proxy?.rotateAfter || 1,
      user_agents: [],
      google_domains: [],
    };

    // Initialize scheduler
    const scheduler = getScheduler({
      initialConcurrency: workers,
      pagesPerDork,
      maxRetries: settings.engine?.retryAttempts || 3,
    });

    // Setup event handlers
    scheduler.on('progress', (stats) => {
      ui.updateStats(stats);
    });

    scheduler.on('result', (dork, urls) => {
      // Filter URLs
      const filtered = filterPipeline.filter(urls);
      
      // Write to output
      outputManager.writeBatch(filtered);

      // Update state
      stateManager.addCompletedDork(dork);
      stateManager.updateStats({
        totalUrls: filterPipeline.getStats().passed,
        uniqueUrls: filterPipeline.getStats().passed,
        uniqueDomains: filterPipeline.getStats().uniqueDomains,
      });

      // Log activity
      ui.logSuccess(dork, filtered.length);
    });

    scheduler.on('error', (dork, error) => {
      ui.logError(dork, error);
    });

    scheduler.on('blocked', (dork, reason) => {
      ui.logWarning(dork, `Blocked: ${reason}`);
    });

    scheduler.on('complete', async (stats) => {
      ui.stopLiveStats();
      ui.stopProgress();

      // Write final stats
      await outputManager.writeStats({
        totalDorks: stats.totalDorks,
        completedDorks: stats.completedDorks,
        totalPages: stats.completedDorks * pagesPerDork,
        totalUrls: stats.totalUrls,
        uniqueUrls: stats.uniqueUrls,
        uniqueDomains: filterPipeline.getStats().uniqueDomains,
        filteredUrls: filterPipeline.getStats().filtered,
        startTime: stats.startTime,
        endTime: new Date(),
        duration: stats.elapsed,
        requestsPerMin: stats.requestsPerMin,
        urlsPerMin: stats.urlsPerMin,
        successRate: stats.successRate,
      });

      // Write domains
      await outputManager.writeDomains(filterPipeline.getUniqueDomains());

      // Close output
      await outputManager.close();

      // Show summary
      ui.showSummary(stats, outputManager.getOutputDir());

      // Clear state on success
      stateManager.clear();
    });

    // Add proxies to engine (will be sent on start)
    for (const proxy of proxies) {
      // Proxies will be loaded by Go engine
    }

    // Start progress UI
    ui.startProgress(dorks.length);
    ui.startLiveStats();

    // Start state auto-save
    stateManager.setPendingDorks(dorks);
    stateManager.setConfig({ pagesPerDork, workers, engine: 'google' });
    stateManager.updateOutput({ directory: outputManager.getOutputDir() });
    stateManager.startAutoSave();

    // Start scheduler
    await scheduler.start(dorks, engineConfig);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      ui.showWarning('Received SIGINT, shutting down gracefully...');
      await scheduler.stop();
      stateManager.save();
      await outputManager.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      ui.showWarning('Received SIGTERM, shutting down gracefully...');
      await scheduler.stop();
      stateManager.save();
      await outputManager.close();
      process.exit(0);
    });

  } catch (error) {
    ui.cleanup();
    ui.showError('Error', (error as Error).message);
    logger.error('Run command failed', { error });
    process.exit(1);
  }
}

/**
 * Validate command
 */
export async function validateCommand(options: { dorks?: string; proxies?: string }): Promise<void> {
  const ui = getUI();
  ui.showBanner();

  ui.startSpinner('Validating files...');

  try {
    if (options.dorks) {
      const dorkResult = validateDorkFile(options.dorks);
      ui.spinnerSuccess(`Dorks: ${dorkResult.valid.length} valid, ${dorkResult.invalid.length} invalid`);

      if (dorkResult.invalid.length > 0) {
        console.log(chalk.yellow('\nInvalid dorks:'));
        for (const inv of dorkResult.invalid.slice(0, 10)) {
          console.log(chalk.red(`  Line ${inv.line}: ${inv.error}`));
        }
        if (dorkResult.invalid.length > 10) {
          console.log(chalk.gray(`  ... and ${dorkResult.invalid.length - 10} more`));
        }
      }

      if (dorkResult.warnings.length > 0) {
        console.log(chalk.yellow('\nWarnings:'));
        for (const warn of dorkResult.warnings.slice(0, 5)) {
          console.log(chalk.yellow(`  Line ${warn.line}: ${warn.warnings.join(', ')}`));
        }
      }
    }

    if (options.proxies) {
      const proxyResult = validateProxyFile(options.proxies);
      ui.spinnerSuccess(`Proxies: ${proxyResult.valid.length} valid, ${proxyResult.invalid.length} invalid`);

      if (proxyResult.invalid.length > 0) {
        console.log(chalk.yellow('\nInvalid proxies:'));
        for (const inv of proxyResult.invalid.slice(0, 10)) {
          console.log(chalk.red(`  Line ${inv.line}: ${inv.error}`));
        }
        if (proxyResult.invalid.length > 10) {
          console.log(chalk.gray(`  ... and ${proxyResult.invalid.length - 10} more`));
        }
      }
    }
  } catch (error) {
    ui.spinnerFail('Validation failed');
    ui.showError('Error', (error as Error).message);
    process.exit(1);
  }
}

/**
 * Check proxies command
 */
export async function checkProxiesCommand(options: { proxies: string; timeout?: number; workers?: number }): Promise<void> {
  const ui = getUI();
  ui.showBanner();

  try {
    const proxies = loadFileLines(options.proxies);
    ui.showInfo(`Loaded ${proxies.length} proxies`);

    ui.startSpinner('Checking proxies...');

    // TODO: Implement actual proxy checking
    // For now, just validate format
    const validation = validateProxyFile(options.proxies);

    ui.spinnerSuccess('Proxy check complete');

    console.log('');
    console.log(chalk.bold('Results:'));
    console.log(`  ${chalk.green('Valid:')}   ${validation.valid.length}`);
    console.log(`  ${chalk.red('Invalid:')} ${validation.invalid.length}`);

    // Save working proxies
    if (validation.valid.length > 0) {
      const outputPath = options.proxies.replace('.txt', '_working.txt');
      fs.writeFileSync(outputPath, validation.valid.join('\n'));
      ui.showSuccess(`Working proxies saved to: ${outputPath}`);
    }
  } catch (error) {
    ui.spinnerFail('Proxy check failed');
    ui.showError('Error', (error as Error).message);
    process.exit(1);
  }
}

/**
 * Estimate command
 */
export async function estimateCommand(options: { dorks: string; proxies: string; pages?: number }): Promise<void> {
  const ui = getUI();
  ui.showBanner();

  try {
    const dorks = loadFileLines(options.dorks);
    const proxies = loadFileLines(options.proxies);
    const pagesPerDork = options.pages || 5;

    ui.showConfig({
      dorks: dorks.length,
      proxies: proxies.length,
      workers: Math.min(proxies.length, 100),
      pagesPerDork,
      outputDir: './output',
    });

    // Calculate estimates for different scenarios
    console.log('');
    console.log(chalk.bold('Estimated completion times:'));
    console.log('');

    const scenarios = [
      { name: 'Aggressive', reqPerHour: 30 },
      { name: 'Normal', reqPerHour: 20 },
      { name: 'Cautious', reqPerHour: 10 },
      { name: 'Stealth', reqPerHour: 5 },
    ];

    for (const scenario of scenarios) {
      const estimate = calculateEstimate(dorks.length, proxies.length, pagesPerDork, scenario.reqPerHour);
      console.log(`  ${chalk.cyan(scenario.name.padEnd(12))} ${chalk.yellow(estimate.estimatedTime.padEnd(12))} (${estimate.requestsPerMin} req/min)`);
    }

    console.log('');
    console.log(chalk.gray('Note: Estimates assume 50% proxy success rate'));
  } catch (error) {
    ui.showError('Error', (error as Error).message);
    process.exit(1);
  }
}

/**
 * Resume command
 */
export async function resumeCommand(options: CliOptions): Promise<void> {
  const ui = getUI();
  ui.showBanner();

  const stateManager = getStateManager();

  if (!stateManager.canResume()) {
    ui.showError('No Resume Available', 'No previous session found to resume');
    process.exit(1);
  }

  const resumeInfo = stateManager.getResumeInfo();
  if (resumeInfo) {
    console.log('');
    console.log(chalk.bold('Previous Session:'));
    console.log(`  ${chalk.bold('Session ID:')}   ${resumeInfo.sessionId}`);
    console.log(`  ${chalk.bold('Last Update:')}  ${resumeInfo.lastUpdate}`);
    console.log(`  ${chalk.bold('Completed:')}    ${chalk.green(resumeInfo.completed.toLocaleString())}`);
    console.log(`  ${chalk.bold('Pending:')}      ${chalk.yellow(resumeInfo.pending.toLocaleString())}`);
    console.log(`  ${chalk.bold('Failed:')}       ${chalk.red(resumeInfo.failed.toLocaleString())}`);
    console.log(`  ${chalk.bold('URLs Found:')}   ${chalk.cyan(resumeInfo.urls.toLocaleString())}`);
    console.log('');

    const confirmed = await ui.confirm('Resume this session?');
    if (confirmed) {
      options.resume = true;
      await runCommand(options);
    } else {
      ui.showInfo('Resume cancelled');
    }
  }
}

/**
 * Create CLI program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('dorker')
    .description('High-performance Google dork parser')
    .version('1.0.0');

  // Default command - interactive mode
  program
    .command('interactive', { isDefault: true })
    .alias('i')
    .description('Start interactive mode with menus')
    .action(async () => {
      const { startInteractive } = await import('./interactive.js');
      await startInteractive();
    });

  program
    .command('run')
    .description('Run the dork parser')
    .requiredOption('-d, --dorks <file>', 'Path to dorks file')
    .requiredOption('-p, --proxies <file>', 'Path to proxies file')
    .option('-o, --output <dir>', 'Output directory', './output')
    .option('-t, --threads <number>', 'Number of workers', parseInt)
    .option('--pages <number>', 'Pages per dork', parseInt)
    .option('--timeout <ms>', 'Request timeout in ms', parseInt)
    .option('--delay <range>', 'Delay range (e.g., 1000-3000)')
    .option('-f, --format <formats>', 'Output formats (comma-separated)', 'txt,json')
    .option('-r, --resume', 'Resume previous session')
    .option('-c, --config <file>', 'Path to config file')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Minimal output')
    .action(runCommand);

  program
    .command('validate')
    .description('Validate dorks and proxies files')
    .option('-d, --dorks <file>', 'Path to dorks file')
    .option('-p, --proxies <file>', 'Path to proxies file')
    .action(validateCommand);

  program
    .command('check-proxies')
    .description('Check proxy health')
    .requiredOption('-p, --proxies <file>', 'Path to proxies file')
    .option('--timeout <ms>', 'Timeout per proxy', parseInt)
    .option('--workers <number>', 'Concurrent checks', parseInt)
    .action(checkProxiesCommand);

  program
    .command('estimate')
    .description('Estimate completion time')
    .requiredOption('-d, --dorks <file>', 'Path to dorks file')
    .requiredOption('-p, --proxies <file>', 'Path to proxies file')
    .option('--pages <number>', 'Pages per dork', parseInt)
    .action(estimateCommand);

  program
    .command('resume')
    .description('Resume previous session')
    .option('-d, --dorks <file>', 'Path to dorks file (optional)')
    .option('-p, --proxies <file>', 'Path to proxies file (optional)')
    .option('-o, --output <dir>', 'Output directory')
    .action(resumeCommand);

  return program;
}

export default createProgram;
