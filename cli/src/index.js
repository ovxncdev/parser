#!/usr/bin/env node

import { Command } from 'commander';
import { readFile, access, constants } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DorkerUI, showBanner } from './ui.js';
import { WorkerIPC } from './ipc.js';
import { FilterPipeline } from './filters.js';
import { OutputWriter, formatNumber, formatDuration } from './output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

const program = new Command();

program
  .name('dorker')
  .description('High-performance Google Dork parser')
  .version(VERSION);

program
  .command('run')
  .description('Run dorker with dorks and proxies')
  .requiredOption('-d, --dorks <file>', 'Path to dorks file')
  .requiredOption('-p, --proxies <file>', 'Path to proxies file')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('-w, --workers <n>', 'Number of workers', '10')
  .option('--timeout <ms>', 'Request timeout', '30000')
  .option('--base-delay <ms>', 'Base delay between requests', '8000')
  .option('--min-delay <ms>', 'Minimum delay', '3000')
  .option('--max-delay <ms>', 'Maximum delay', '15000')
  .option('--max-retries <n>', 'Max retries per dork', '3')
  .option('--no-anti-public', 'Disable anti-public filter')
  .option('--no-dedup', 'Disable URL deduplication')
  .option('--no-domain-dedup', 'Disable domain deduplication')
  .option('--params-only', 'Keep only URLs with parameters')
  .option('--no-ui', 'Disable fancy UI')
  .option('--format <type>', 'Output format: txt, json, csv, jsonl', 'txt')
  .action(runCommand);

program
  .command('validate')
  .description('Validate dorks and proxies files')
  .requiredOption('-d, --dorks <file>', 'Path to dorks file')
  .requiredOption('-p, --proxies <file>', 'Path to proxies file')
  .action(validateCommand);

async function runCommand(opts) {
  const startTime = Date.now();
  const useUI = opts.ui !== false && process.stdout.isTTY;

  // Validate files
  try {
    await access(opts.dorks, constants.R_OK);
    await access(opts.proxies, constants.R_OK);
  } catch (err) {
    console.error('Error: Cannot read dorks or proxies file');
    process.exit(1);
  }

  // Find worker
  const workerPath = findWorker();
  if (!workerPath) {
    console.error('Error: Worker binary not found. Run "make build-worker" first.');
    process.exit(1);
  }

  // Load dorks
  const dorksContent = await readFile(opts.dorks, 'utf-8');
  const dorks = dorksContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  if (dorks.length === 0) {
    console.error('Error: No dorks found');
    process.exit(1);
  }

  // Create output dir
  if (!existsSync(opts.output)) {
    mkdirSync(opts.output, { recursive: true });
  }

  // Initialize components
  const filter = new FilterPipeline({
    antiPublic: opts.antiPublic !== false,
    dedup: opts.dedup !== false,
    domainDedup: opts.domainDedup !== false,
    paramsOnly: opts.paramsOnly || false
  });

  const output = new OutputWriter({
    directory: opts.output,
    format: opts.format
  });

  const worker = new WorkerIPC(workerPath);

  // UI or console
  let ui = null;
  if (useUI) {
    ui = new DorkerUI();
    ui.init();
    ui.showInitPhase();
  } else {
    showBanner();
    console.log(`Dorks: ${formatNumber(dorks.length)}`);
    console.log(`Worker: ${workerPath}`);
    console.log('');
  }

  // State
  const state = {
    completed: 0,
    failed: 0,
    urlsRaw: 0,
    urlsFiltered: 0,
    lastStats: null,
    failedDorks: []
  };

  // Worker events - status handles ready/initialized
  worker.on('status', (status, message) => {
    if (status === 'ready') {
      log(ui, 'success', 'Worker ready');
    } else if (status === 'initialized') {
      log(ui, 'success', `Initialized: ${message}`);
      if (ui) ui.showRunning();

      // Submit tasks
      worker.submitTasks(dorks);
      log(ui, 'info', `Submitted ${formatNumber(dorks.length)} tasks`);
    } else if (status === 'paused') {
      log(ui, 'warning', 'Paused');
      if (ui) ui.showPaused();
    } else if (status === 'resumed') {
      log(ui, 'info', 'Resumed');
      if (ui) ui.showRunning();
    }
  });

  worker.on('result', (data) => {
    const { dork, status, urls, error } = data;

    if (status === 'success' || status === 'no_results') {
      state.completed++;
      state.urlsRaw += urls.length;

      if (urls.length > 0) {
        const filtered = filter.filter(urls);
        state.urlsFiltered += filtered.length;
        for (const url of filtered) {
          output.writeUrl(url, { dork, timestamp: Date.now() });
        }
      }

      if (ui) {
        ui.addActivity('success', dork, `→ ${urls.length} URLs`);
      }
    } else {
      state.failed++;
      state.failedDorks.push(dork);

      if (ui) {
        const msg = status === 'captcha' ? '→ CAPTCHA'
                  : status === 'blocked' ? '→ Blocked'
                  : `→ ${error || status}`;
        ui.addActivity(status === 'captcha' ? 'warning' : 'error', dork, msg);
      }
    }
  });

  worker.on('stats', (stats) => {
    state.lastStats = stats;
    if (ui) {
      ui.updateStats({
        requestsPerMin: Math.round(stats.requestsPerSec * 60),
        successRate: stats.tasksCompleted > 0 
          ? (stats.tasksCompleted / (stats.tasksCompleted + stats.tasksFailed)) * 100 : 0,
        urlsFound: state.urlsFiltered,
        uniqueDomains: filter.getStats().uniqueDomains
      });
      ui.updateThroughput(stats.requestsPerSec);
      ui.updateTiming(stats.elapsedMs, stats.etaMs);
    }
  });

  worker.on('progress', (progress) => {
    if (ui) {
      ui.updateProgress(progress.current, progress.total);
      ui.updateResults(state.urlsRaw, state.urlsFiltered, filter.getStats().uniqueDomains);
    } else {
      process.stdout.write(`\rProgress: ${progress.current}/${progress.total} (${progress.percentage.toFixed(1)}%) - ${state.urlsFiltered} URLs   `);
    }

    if (progress.current >= progress.total && progress.total > 0) {
      finish();
    }
  });

  worker.on('proxy_info', (info) => {
    if (ui) {
      ui.updateProxies(info.alive, info.dead, info.quarantined);
    } else {
      log(ui, 'info', `Proxies: ${info.alive} alive, ${info.dead} dead`);
    }
  });

  worker.on('error', (code, message) => {
    log(ui, 'error', `[${code}] ${message}`);
  });

  worker.on('close', (code) => {
    if (code !== 0 && code !== null) {
      log(ui, 'error', `Worker exited with code ${code}`);
    }
    finish();
  });

  // UI callbacks
  if (ui) {
    ui.setCallbacks({
      onPause: () => worker.pause(),
      onResume: () => worker.resume(),
      onQuit: () => { worker.shutdown(); setTimeout(finish, 1000); }
    });
  }

  // Stats polling
  const statsInterval = setInterval(() => {
    if (worker.isConnected()) worker.getStats();
  }, 1000);

  // Finish handler
  let finished = false;
  async function finish() {
    if (finished) return;
    finished = true;
    clearInterval(statsInterval);

    const duration = Date.now() - startTime;
    const filterStats = filter.getStats();

    if (state.failedDorks.length > 0) {
      await output.writeFailedDorks(state.failedDorks);
    }

    await output.writeSummary({
      duration,
      totalDorks: dorks.length,
      completed: state.completed,
      failed: state.failed,
      rawUrls: state.urlsRaw,
      filteredUrls: state.urlsFiltered,
      uniqueDomains: filterStats.uniqueDomains
    });

    await output.close();

    if (ui) {
      ui.showComplete({
        totalDorks: dorks.length,
        duration,
        totalRequests: state.completed + state.failed,
        successRate: state.completed > 0 ? (state.completed / (state.completed + state.failed)) * 100 : 0,
        rawUrls: state.urlsRaw,
        afterDedup: filterStats.afterDedup,
        afterFilter: state.urlsFiltered,
        finalDomains: filterStats.uniqueDomains,
        outputDir: output.getOutputDir()
      });
    } else {
      console.log('\n');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('                         COMPLETE');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log(`  Duration: ${formatDuration(duration)}`);
      console.log(`  Dorks:    ${state.completed} completed, ${state.failed} failed`);
      console.log(`  URLs:     ${formatNumber(state.urlsFiltered)} saved`);
      console.log(`  Domains:  ${formatNumber(filterStats.uniqueDomains)} unique`);
      console.log(`  Output:   ${output.getOutputDir()}`);
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(0);
    }
  }

  process.on('SIGINT', () => { worker.shutdown(); setTimeout(finish, 1000); });
  process.on('SIGTERM', () => { worker.shutdown(); setTimeout(finish, 1000); });

  // Start worker and send init immediately
  try {
    await worker.start();
    
    // Send init right after start
    log(ui, 'info', 'Sending init to worker...');
    worker.init({
      workers: parseInt(opts.workers),
      timeout: parseInt(opts.timeout),
      baseDelay: parseInt(opts.baseDelay),
      minDelay: parseInt(opts.minDelay),
      maxDelay: parseInt(opts.maxDelay),
      maxRetries: parseInt(opts.maxRetries),
      resultsPerPage: 100,
      proxyFile: path.resolve(opts.proxies)
    });
  } catch (err) {
    log(ui, 'error', `Failed to start: ${err.message}`);
    process.exit(1);
  }
}

async function validateCommand(opts) {
  showBanner();
  console.log('Validating...\n');

  for (const [name, file] of [['Dorks', opts.dorks], ['Proxies', opts.proxies]]) {
    console.log(`${name}: ${file}`);
    try {
      await access(file, constants.R_OK);
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      console.log(`  ✓ ${formatNumber(lines.length)} entries`);
    } catch {
      console.log('  ✗ Cannot read');
    }
  }
  console.log('\nDone.');
}

function findWorker() {
  const paths = [
    path.join(process.cwd(), 'bin', 'worker'),
    path.join(process.cwd(), '..', 'bin', 'worker'),
    path.join(__dirname, '..', '..', 'bin', 'worker'),
  ];
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

function log(ui, type, message) {
  if (ui) {
    ui.addActivity(type, '', message);
  } else {
    const prefix = type === 'error' ? '✗' : type === 'warning' ? '⚠' : type === 'success' ? '✓' : 'ℹ';
    console.log(`${prefix} ${message}`);
  }
}

program.parse();
