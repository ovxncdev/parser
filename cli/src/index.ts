#!/usr/bin/env node

import { Command } from 'commander';
import { readFile, access, constants, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WorkerIPC } from './ipc.js';
import { FilterPipeline, createFilter } from './filters.js';
import { OutputWriter, createOutputWriter, formatDuration, formatNumber } from './output.js';
import { TerminalUI, showBanner } from './ui.js';
import type {
  CLIConfig,
  InitConfig,
  TaskData,
  ResultData,
  StatsData,
  SearchResult,
  DEFAULT_CONFIG,
} from './types.js';

const VERSION = '1.0.0';

// Main CLI program
const program = new Command();

program
  .name('dorker')
  .description('High-performance Google Dork parser')
  .version(VERSION);

program
  .command('run')
  .description('Run the dorker with specified dorks and proxies')
  .requiredOption('-d, --dorks <file>', 'Path to dorks file')
  .requiredOption('-p, --proxies <file>', 'Path to proxies file')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('-w, --workers <number>', 'Number of concurrent workers', '10')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
  .option('--base-delay <ms>', 'Base delay between requests', '8000')
  .option('--min-delay <ms>', 'Minimum delay between requests', '3000')
  .option('--max-delay <ms>', 'Maximum delay between requests', '15000')
  .option('--max-retries <number>', 'Maximum retries per dork', '3')
  .option('--results-per-page <number>', 'Results per search page', '100')
  .option('--no-anti-public', 'Disable anti-public domain filter')
  .option('--no-dedup', 'Disable URL deduplication')
  .option('--no-domain-dedup', 'Disable domain deduplication')
  .option('--params-only', 'Keep only URLs with parameters')
  .option('--no-ui', 'Run without terminal UI')
  .option('--format <type>', 'Output format (txt, json, csv, jsonl)', 'txt')
  .option('--split-by-dork', 'Create separate output files per dork')
  .option('--anti-public-file <file>', 'Additional anti-public domains file')
  .action(runCommand);

program
  .command('validate')
  .description('Validate dorks and proxies files')
  .requiredOption('-d, --dorks <file>', 'Path to dorks file')
  .requiredOption('-p, --proxies <file>', 'Path to proxies file')
  .action(validateCommand);

program
  .command('filter')
  .description('Filter existing results file')
  .requiredOption('-i, --input <file>', 'Input file with URLs')
  .option('-o, --output <file>', 'Output file', 'filtered.txt')
  .option('--no-anti-public', 'Disable anti-public domain filter')
  .option('--no-dedup', 'Disable URL deduplication')
  .option('--params-only', 'Keep only URLs with parameters')
  .action(filterCommand);

// Run command implementation
async function runCommand(options: Record<string, unknown>): Promise<void> {
  const startTime = Date.now();
  
  // Show banner
  showBanner();

  // Parse options
  const config: CLIConfig = {
    dorksFile: options['dorks'] as string,
    proxiesFile: options['proxies'] as string,
    outputDir: options['output'] as string,
    workers: parseInt(options['workers'] as string, 10),
    timeout: parseInt(options['timeout'] as string, 10),
    baseDelay: parseInt(options['baseDelay'] as string, 10),
    minDelay: parseInt(options['minDelay'] as string, 10),
    maxDelay: parseInt(options['maxDelay'] as string, 10),
    maxRetries: parseInt(options['maxRetries'] as string, 10),
    resultsPerPage: parseInt(options['resultsPerPage'] as string, 10),
    filters: {
      cleanTopDomains: false,
      urlParametersOnly: options['paramsOnly'] as boolean || false,
      noRedirectUrls: true,
      removeDuplicateDomains: options['domainDedup'] !== false,
      antiPublic: options['antiPublic'] !== false,
      keepUnfiltered: true,
      antiPublicFile: options['antiPublicFile'] as string | undefined,
    },
  };

  const useUI = options['ui'] !== false;

  // Validate files exist
  try {
    await access(config.dorksFile, constants.R_OK);
    await access(config.proxiesFile, constants.R_OK);
  } catch {
    console.error('Error: Cannot read dorks or proxies file');
    process.exit(1);
  }

  // Create output directory
  if (!existsSync(config.outputDir)) {
    await mkdir(config.outputDir, { recursive: true });
  }

  // Load dorks
  console.log('Loading dorks...');
  const dorksContent = await readFile(config.dorksFile, 'utf-8');
  const dorks = dorksContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  
  console.log(`Loaded ${formatNumber(dorks.length)} dorks`);

  // Initialize components
  const filter = createFilter(config.filters);
  const output = createOutputWriter({
    format: options['format'] as 'txt' | 'json' | 'csv' | 'jsonl',
    directory: config.outputDir,
    prefix: 'dorker',
    splitByDork: options['splitByDork'] as boolean || false,
    includeMetadata: false,
  });

  // Load additional anti-public domains
  if (config.filters.antiPublicFile) {
    try {
      const antiPublicContent = await readFile(config.filters.antiPublicFile, 'utf-8');
      const domains = antiPublicContent.split('\n').filter((d) => d.trim());
      filter.loadAntiPublicDomains(domains);
      console.log(`Loaded ${domains.length} additional anti-public domains`);
    } catch {
      console.warn('Warning: Could not load anti-public domains file');
    }
  }

  // Find worker binary
  const workerPath = findWorkerBinary();
  if (!workerPath) {
    console.error('Error: Worker binary not found. Run "make build" first.');
    process.exit(1);
  }

  console.log(`Using worker: ${workerPath}`);

  // Initialize worker
  console.log('Starting worker...');
  const worker = new WorkerIPC(workerPath);

  // UI or simple console
  let ui: TerminalUI | null = null;
  if (useUI && process.stdout.isTTY) {
    ui = new TerminalUI();
  }

  // Track state
  let completedTasks = 0;
  let failedTasks = 0;
  let totalUrls = 0;
  let lastStats: StatsData | null = null;
  const failedDorks: string[] = [];

  // Set up worker event handlers
  worker.on('ready', () => {
    if (ui) {
      ui.log('Worker connected', 'success');
    } else {
      console.log('Worker connected');
    }

    // Initialize worker
    const initConfig: InitConfig = {
      workers: config.workers,
      timeout: config.timeout,
      base_delay: config.baseDelay,
      min_delay: config.minDelay,
      max_delay: config.maxDelay,
      max_retries: config.maxRetries,
      results_per_page: config.resultsPerPage,
      proxy_file: path.resolve(config.proxiesFile),
    };

    worker.init(initConfig);
  });

  worker.on('status', (status, message) => {
    if (status === 'initialized') {
      if (ui) {
        ui.log(`Worker initialized: ${message}`, 'success');
      } else {
        console.log(`Worker initialized: ${message}`);
      }

      // Submit all tasks
      submitTasks(worker, dorks);
    } else if (status === 'paused') {
      if (ui) {
        ui.setPaused(true);
        ui.log('Worker paused', 'warning');
      }
    } else if (status === 'resumed') {
      if (ui) {
        ui.setPaused(false);
        ui.log('Worker resumed', 'success');
      }
    }
  });

  worker.on('result', (data: ResultData) => {
    if (data.status === 'success' || data.status === 'no_results') {
      completedTasks++;
      
      // Filter and write URLs
      if (data.urls.length > 0) {
        const results: SearchResult[] = data.urls.map((url) => ({
          url,
          dork: data.dork,
          timestamp: Date.now(),
        }));

        for (const result of results) {
          const filtered = filter.filterSingle(result);
          if (filtered) {
            output.write(filtered);
            totalUrls++;
          }
        }
      }

      if (ui) {
        ui.addActivity({
          timestamp: Date.now(),
          type: 'success',
          dork: truncate(data.dork, 40),
          message: truncate(data.dork, 40),
          urls: data.urls.length,
        });
      }
    } else {
      failedTasks++;
      failedDorks.push(data.dork);

      if (ui) {
        ui.addActivity({
          timestamp: Date.now(),
          type: 'error',
          dork: truncate(data.dork, 40),
          message: `${data.status}: ${data.error || 'Unknown error'}`,
        });
      }
    }
  });

  worker.on('stats', (stats: StatsData) => {
    lastStats = stats;
    if (ui) {
      ui.updateStats(stats);
    }
  });

  worker.on('progress', (progress) => {
    if (ui) {
      ui.updateProgress(progress);
    } else {
      const pct = progress.percentage.toFixed(1);
      process.stdout.write(`\rProgress: ${progress.current}/${progress.total} (${pct}%)   `);
    }

    // Check if complete
    if (progress.current >= progress.total && progress.total > 0) {
      finish();
    }
  });

  worker.on('proxy_info', (info) => {
    if (ui) {
      ui.updateProxyInfo(info);
    } else {
      console.log(`Proxies: ${info.alive} alive, ${info.dead} dead, ${info.quarantined} quarantined`);
    }
  });

  worker.on('error', (code, message) => {
    if (ui) {
      ui.log(`Error [${code}]: ${message}`, 'error');
    } else {
      console.error(`Error [${code}]: ${message}`);
    }
  });

  worker.on('log', (level, message) => {
    if (ui) {
      const type = level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'info';
      ui.log(message, type);
    }
  });

  worker.on('close', (code) => {
    if (code !== 0 && code !== null) {
      if (ui) {
        ui.showError(`Worker exited with code ${code}`);
      } else {
        console.error(`Worker exited with code ${code}`);
      }
    }
    finish();
  });

  // UI callbacks
  if (ui) {
    ui.setCallbacks({
      onPause: () => worker.pause(),
      onResume: () => worker.resume(),
      onQuit: () => {
        worker.shutdown();
        setTimeout(() => finish(), 1000);
      },
    });

    ui.setRunning(true);
  }

  // Stats polling
  const statsInterval = setInterval(() => {
    if (worker.isConnected()) {
      worker.getStats();
    }
  }, 1000);

  // Finish function
  async function finish(): Promise<void> {
    clearInterval(statsInterval);

    const duration = Date.now() - startTime;

    // Close output
    await output.close();

    // Write failed dorks
    if (failedDorks.length > 0) {
      await output.writeFailedDorks(failedDorks);
    }

    // Write summary
    if (lastStats) {
      const filterStats = filter.getStats();
      await output.writeSummary(lastStats, filterStats, duration, output.getOutputFiles());
    }

    // Show completion
    if (ui && lastStats) {
      ui.showComplete(lastStats, duration);
    } else {
      console.log('\n');
      console.log('═══════════════════════════════════════════════════════════════════');
      console.log('                           COMPLETE');
      console.log('═══════════════════════════════════════════════════════════════════');
      console.log(`  Duration:      ${formatDuration(duration)}`);
      console.log(`  Dorks:         ${completedTasks} completed, ${failedTasks} failed`);
      console.log(`  URLs:          ${formatNumber(totalUrls)} saved`);
      console.log(`  Output:        ${config.outputDir}`);
      console.log('═══════════════════════════════════════════════════════════════════');
      process.exit(0);
    }
  }

  // Handle process signals
  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down...');
    worker.shutdown();
    setTimeout(() => finish(), 1000);
  });

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...');
    worker.shutdown();
    setTimeout(() => finish(), 1000);
  });

  // Start worker
  try {
    await worker.start();
  } catch (err) {
    console.error('Failed to start worker:', err);
    process.exit(1);
  }
}

// Validate command implementation
async function validateCommand(options: Record<string, unknown>): Promise<void> {
  showBanner();

  const dorksFile = options['dorks'] as string;
  const proxiesFile = options['proxies'] as string;

  console.log('Validating files...\n');

  // Validate dorks
  console.log(`Dorks file: ${dorksFile}`);
  try {
    await access(dorksFile, constants.R_OK);
    const content = await readFile(dorksFile, 'utf-8');
    const dorks = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    
    console.log(`  ✓ ${formatNumber(dorks.length)} dorks found`);
    
    // Check for duplicates
    const unique = new Set(dorks);
    if (unique.size < dorks.length) {
      console.log(`  ⚠ ${dorks.length - unique.size} duplicate dorks`);
    }
  } catch {
    console.log('  ✗ Cannot read file');
  }

  console.log();

  // Validate proxies
  console.log(`Proxies file: ${proxiesFile}`);
  try {
    await access(proxiesFile, constants.R_OK);
    const content = await readFile(proxiesFile, 'utf-8');
    const proxies = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    
    console.log(`  ✓ ${formatNumber(proxies.length)} proxy entries found`);
  } catch {
    console.log('  ✗ Cannot read file');
  }

  console.log('\nValidation complete.');
}

// Filter command implementation
async function filterCommand(options: Record<string, unknown>): Promise<void> {
  const inputFile = options['input'] as string;
  const outputFile = options['output'] as string;

  console.log(`Filtering ${inputFile}...`);

  const filter = createFilter({
    cleanTopDomains: false,
    urlParametersOnly: options['paramsOnly'] as boolean || false,
    noRedirectUrls: true,
    removeDuplicateDomains: true,
    antiPublic: options['antiPublic'] !== false,
    keepUnfiltered: false,
  });

  const content = await readFile(inputFile, 'utf-8');
  const urls = content.split('\n').filter((line) => line.trim());

  const results: SearchResult[] = urls.map((url) => ({
    url,
    dork: 'filter',
    timestamp: Date.now(),
  }));

  const filtered = filter.filter(results);

  const output = createOutputWriter({
    format: 'txt',
    directory: path.dirname(outputFile),
    prefix: path.basename(outputFile, path.extname(outputFile)),
    splitByDork: false,
    includeMetadata: false,
  });

  output.writeMany(filtered);
  await output.close();

  const stats = filter.getStats();
  console.log(`\nFilter results:`);
  console.log(`  Input:       ${formatNumber(stats.totalInput)}`);
  console.log(`  Output:      ${formatNumber(stats.finalOutput)}`);
  console.log(`  Removed:     ${formatNumber(stats.totalInput - stats.finalOutput)}`);
  console.log(`  Saved to:    ${outputFile}`);
}

// Helper functions
function submitTasks(worker: WorkerIPC, dorks: string[]): void {
  const tasks: TaskData[] = dorks.map((dork, index) => ({
    task_id: `task_${index}`,
    dork,
    page: 0,
  }));

  // Submit in batches
  const BATCH_SIZE = 100;
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);
    worker.submitTasks(batch);
  }
}

function findWorkerBinary(): string | null {
  const possiblePaths = [
    path.join(process.cwd(), 'bin', 'worker'),
    path.join(process.cwd(), '..', 'bin', 'worker'),
    path.join(__dirname, '..', '..', 'bin', 'worker'),
    path.join(__dirname, '..', '..', '..', 'bin', 'worker'),
  ];

  // Add .exe for Windows
  if (process.platform === 'win32') {
    possiblePaths.push(...possiblePaths.map((p) => p + '.exe'));
  }

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.substring(0, length - 3) + '...';
}

// Run program
program.parse();
