#!/usr/bin/env node

import { Command } from 'commander';
import { readFile, access, constants, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DorkerUI, showBanner } from './ui.js';
import { WorkerIPC } from './ipc.js';
import { FilterPipeline } from './filters.js';
import { OutputWriter, formatNumber, formatDuration } from './output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────
// CLI Setup
// ─────────────────────────────────────────────────────────────

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
  .option('--no-ui', 'Disable fancy UI (use simple output)')
  .option('--format <type>', 'Output format: txt, json, csv, jsonl', 'txt')
  .action(runCommand);

program
  .command('validate')
  .description('Validate dorks and proxies files')
  .requiredOption('-d, --dorks <file>', 'Path to dorks file')
  .requiredOption('-p, --proxies <file>', 'Path to proxies file')
  .action(validateCommand);

// ─────────────────────────────────────────────────────────────
// Run Command
// ─────────────────────────────────────────────────────────────

async function runCommand(opts) {
  const startTime = Date.now();
  const useUI = opts.ui !== false && process.stdout.isTTY;

  // Validate files exist
  try {
    await access(opts.dorks, constants.R_OK);
    await access(opts.proxies, constants.R_OK);
  } catch (err) {
    console.error('Error: Cannot read dorks or proxies file');
    console.error(err.message);
    process.exit(1);
  }

  // Find worker binary
  const workerPath = findWorker();
  if (!workerPath) {
    console.error('Error: Worker binary not found.');
    console.error('Run "make build-worker" in the project root first.');
    process.exit(1);
  }

  // Load dorks
  const dorksContent = await readFile(opts.dorks, 'utf-8');
  const dorks = dorksContent
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (dorks.length === 0) {
    console.error('Error: No dorks found in file');
    process.exit(1);
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

  // Initialize UI or simple console
  let ui = null;
  if (useUI) {
    ui = new DorkerUI();
    ui.init();
    ui.showInitPhase();
  } else {
    showBanner();
    console.log(`Loading ${formatNumber(dorks.length)} dorks...`);
    console.log(`Worker: ${workerPath}`);
    console.log('');
  }

  // State tracking
  const state = {
    completed: 0,
    failed: 0,
    urlsRaw: 0,
    urlsFiltered: 0,
    lastStats: null,
    failedDorks: []
  };

  // ─────────────────────────────────────────────────────────────
  // Worker Events
  // ─────────────────────────────────────────────────────────────

  worker.on('ready', () => {
    log(ui, 'success', 'Worker connected');

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
  });

  worker.on('status', (status, message) => {
    if (status === 'initialized') {
      log(ui, 'success', `Initialized: ${message}`);
      
      if (ui) {
        ui.showRunning();
      }

      // Submit all dorks
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

      // Filter and save URLs
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
          ? (stats.tasksCompleted / (stats.tasksCompleted + stats.tasksFailed)) * 100 
          : 0,
        activeProxies: 0,  // Updated via proxy_info
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
      const pct = progress.percentage.toFixed(1);
      process.stdout.write(`\rProgress: ${progress.current}/${progress.total} (${pct}%) - ${state.urlsFiltered} URLs   `);
    }

    // Check completion
    if (progress.current >= progress.total && progress.total > 0) {
      finish();
    }
  });

  worker.on('proxy_info', (info) => {
    if (ui) {
      ui.updateProxies(info.alive, info.dead, info.quarantined);
    } else {
      console.log(`\nProxies: ${info.alive} alive, ${info.dead} dead, ${info.quarantined} quarantined`);
    }
  });

  worker.on('error', (code, message) => {
    log(ui, 'error', `[${code}] ${message}`);
  });

  worker.on('log', (level, message) => {
    // Debug logs - only show if no UI
    if (!ui && level === 'debug') {
      console.log(`[DEBUG] ${message}`);
    }
  });

  worker.on('close', (code) => {
    if (code !== 0 && code !== null) {
      log(ui, 'error', `Worker exited with code ${code}`);
    }
    finish();
  });

  // ─────────────────────────────────────────────────────────────
  // UI Callbacks
  // ─────────────────────────────────────────────────────────────

  if (ui) {
    ui.setCallbacks({
      onPause: () => worker.pause(),
      onResume: () => worker.resume(),
      onQuit: () => {
        worker.shutdown();
        setTimeout(finish, 1000);
      }
    });
  }

  // Stats polling
  const statsInterval = setInterval(() => {
    if (worker.isConnected()) {
      worker.getStats();
    }
  }, 1000);

  // ─────────────────────────────────────────────────────────────
  // Finish
  // ─────────────────────────────────────────────────────────────

  let finished = false;
  async function finish() {
    if (finished) return;
    finished = true;

    clearInterval(statsInterval);
    const duration = Date.now() - startTime;

    // Save failed dorks
    if (state.failedDorks.length > 0) {
      await output.writeFailedDorks(state.failedDorks);
    }

    // Save summary
    const filterStats = filter.getStats();
    await output.writeSummary({
      duration,
      totalDorks: dorks.length,
      completed: state.completed,
      failed: state.failed,
      rawUrls: state.urlsRaw,
      filteredUrls: state.urlsFiltered,
      uniqueDomains: filterStats.uniqueDomains,
      proxiesTotal: state.lastStats?.proxiesTotal || 0,
      proxiesAlive: state.lastStats?.proxiesAlive || 0,
      requestsPerMin: state.lastStats?.requestsPerSec ? Math.round(state.lastStats.requestsPerSec * 60) : 0,
      successRate: state.completed > 0 ? (state.completed / (state.completed + state.failed)) * 100 : 0
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
      console.log(`  Duration:     ${formatDuration(duration)}`);
      console.log(`  Dorks:        ${state.completed} completed, ${state.failed} failed`);
      console.log(`  URLs:         ${formatNumber(state.urlsFiltered)} saved`);
      console.log(`  Domains:      ${formatNumber(filterStats.uniqueDomains)} unique`);
      console.log(`  Output:       ${output.getOutputDir()}`);
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(0);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Signal Handlers
  // ─────────────────────────────────────────────────────────────

  process.on('SIGINT', () => {
    log(ui, 'warning', 'Interrupted, saving progress...');
    worker.shutdown();
    setTimeout(finish, 1000);
  });

  process.on('SIGTERM', () => {
    worker.shutdown();
    setTimeout(finish, 1000);
  });

  // ─────────────────────────────────────────────────────────────
  // Start Worker
  // ─────────────────────────────────────────────────────────────

  try {
    await worker.start();
  } catch (err) {
    log(ui, 'error', `Failed to start worker: ${err.message}`);
    if (ui) {
      setTimeout(() => process.exit(1), 2000);
    } else {
      process.exit(1);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Validate Command
// ─────────────────────────────────────────────────────────────

async function validateCommand(opts) {
  showBanner();
  console.log('Validating files...\n');

  // Check dorks
  console.log(`Dorks: ${opts.dorks}`);
  try {
    await access(opts.dorks, constants.R_OK);
    const content = await readFile(opts.dorks, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const unique = new Set(lines);
    console.log(`  ✓ ${formatNumber(lines.length)} dorks`);
    if (unique.size < lines.length) {
      console.log(`  ⚠ ${lines.length - unique.size} duplicates`);
    }
  } catch {
    console.log('  ✗ Cannot read file');
  }

  console.log('');

  // Check proxies
  console.log(`Proxies: ${opts.proxies}`);
  try {
    await access(opts.proxies, constants.R_OK);
    const content = await readFile(opts.proxies, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    console.log(`  ✓ ${formatNumber(lines.length)} proxies`);
  } catch {
    console.log('  ✗ Cannot read file');
  }

  console.log('\nDone.');
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function findWorker() {
  const paths = [
    path.join(process.cwd(), 'bin', 'worker'),
    path.join(process.cwd(), '..', 'bin', 'worker'),
    path.join(__dirname, '..', '..', 'bin', 'worker'),
    path.join(__dirname, '..', '..', '..', 'bin', 'worker')
  ];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }
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

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────

program.parse();
