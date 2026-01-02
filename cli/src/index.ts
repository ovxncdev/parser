#!/usr/bin/env node

import { Command } from 'commander';
import { readFile, access, constants, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerIPC } from './ipc.js';
import { createFilter } from './filters.js';
import { createOutputWriter, formatDuration, formatNumber } from './output.js';
import { TerminalUI, showBanner } from './ui.js';

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
  .requiredOption('-d, --dorks <file>', 'Dorks file')
  .requiredOption('-p, --proxies <file>', 'Proxies file')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('-w, --workers <n>', 'Workers', '10')
  .option('--timeout <ms>', 'Timeout', '30000')
  .option('--base-delay <ms>', 'Base delay', '8000')
  .option('--min-delay <ms>', 'Min delay', '3000')
  .option('--max-delay <ms>', 'Max delay', '15000')
  .option('--max-retries <n>', 'Max retries', '3')
  .option('--no-anti-public', 'Disable anti-public filter')
  .option('--no-ui', 'Disable UI')
  .option('--format <type>', 'Output format', 'txt')
  .action(runCommand);

program
  .command('validate')
  .description('Validate files')
  .requiredOption('-d, --dorks <file>', 'Dorks file')
  .requiredOption('-p, --proxies <file>', 'Proxies file')
  .action(validateCommand);

async function runCommand(opts) {
  const startTime = Date.now();
  showBanner();

  // Validate files
  try {
    await access(opts.dorks, constants.R_OK);
    await access(opts.proxies, constants.R_OK);
  } catch {
    console.error('Error: Cannot read dorks or proxies file');
    process.exit(1);
  }

  // Create output dir
  if (!existsSync(opts.output)) {
    await mkdir(opts.output, { recursive: true });
  }

  // Load dorks
  console.log('Loading dorks...');
  const dorksContent = await readFile(opts.dorks, 'utf-8');
  const dorks = dorksContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  console.log(`Loaded ${formatNumber(dorks.length)} dorks`);

  // Init components
  const filter = createFilter({
    antiPublic: opts.antiPublic !== false,
    removeDuplicateDomains: true,
    urlParametersOnly: false,
    noRedirectUrls: true,
  });

  const output = createOutputWriter({
    format: opts.format,
    directory: opts.output,
    prefix: 'dorker',
  });

  // Find worker
  const workerPath = findWorker();
  if (!workerPath) {
    console.error('Error: Worker binary not found. Run "make build-worker" first.');
    process.exit(1);
  }
  console.log(`Using worker: ${workerPath}`);

  // Start worker
  console.log('Starting worker...');
  const worker = new WorkerIPC(workerPath);

  // UI
  let ui = null;
  if (opts.ui !== false && process.stdout.isTTY) {
    ui = new TerminalUI();
  }

  // State
  let completed = 0, failed = 0, totalUrls = 0;
  let lastStats = null;
  const failedDorks = [];

  // Events
  worker.on('ready', () => {
    log('Worker connected', 'success');
    worker.init({
      workers: parseInt(opts.workers),
      timeout: parseInt(opts.timeout),
      base_delay: parseInt(opts.baseDelay),
      min_delay: parseInt(opts.minDelay),
      max_delay: parseInt(opts.maxDelay),
      max_retries: parseInt(opts.maxRetries),
      results_per_page: 100,
      proxy_file: path.resolve(opts.proxies),
    });
  });

  worker.on('status', (status, msg) => {
    if (status === 'initialized') {
      log(`Initialized: ${msg}`, 'success');
      submitTasks(worker, dorks);
    }
  });

  worker.on('result', (data) => {
    if (data.status === 'success' || data.status === 'no_results') {
      completed++;
      data.urls.forEach(url => {
        const result = filter.filterSingle({ url, dork: data.dork, timestamp: Date.now() });
        if (result) { output.write(result); totalUrls++; }
      });
      log(`${truncate(data.dork, 40)} → ${data.urls.length} URLs`, 'success');
    } else {
      failed++;
      failedDorks.push(data.dork);
      log(`${data.status}: ${truncate(data.dork, 40)}`, 'error');
    }
  });

  worker.on('stats', (stats) => {
    lastStats = stats;
    if (ui) ui.updateStats(stats);
  });

  worker.on('progress', (progress) => {
    if (ui) ui.updateProgress(progress);
    else process.stdout.write(`\rProgress: ${progress.current}/${progress.total} (${progress.percentage.toFixed(1)}%)   `);
    if (progress.current >= progress.total && progress.total > 0) finish();
  });

  worker.on('proxy_info', (info) => {
    if (ui) ui.updateProxyInfo(info);
  });

  worker.on('error', (code, msg) => log(`Error [${code}]: ${msg}`, 'error'));
  worker.on('close', (code) => { if (code !== 0) log(`Worker exited: ${code}`, 'error'); finish(); });

  if (ui) {
    ui.setCallbacks({
      onPause: () => worker.pause(),
      onResume: () => worker.resume(),
      onQuit: () => { worker.shutdown(); setTimeout(finish, 1000); },
    });
    ui.setRunning(true);
  }

  const statsInterval = setInterval(() => { if (worker.isConnected()) worker.getStats(); }, 1000);

  function log(msg, type = 'info') {
    if (ui) ui.log(msg, type);
    else console.log(msg);
  }

  async function finish() {
    clearInterval(statsInterval);
    const duration = Date.now() - startTime;
    await output.close();
    if (failedDorks.length) await output.writeFailedDorks(failedDorks);
    if (lastStats) await output.writeSummary(lastStats, filter.getStats(), duration, output.getOutputFiles());

    if (ui && lastStats) {
      ui.showComplete(lastStats, duration);
    } else {
      console.log('\n\n═══════════════════════════════════════════');
      console.log('                 COMPLETE');
      console.log('═══════════════════════════════════════════');
      console.log(`  Duration: ${formatDuration(duration)}`);
      console.log(`  Dorks:    ${completed} completed, ${failed} failed`);
      console.log(`  URLs:     ${formatNumber(totalUrls)} saved`);
      console.log(`  Output:   ${opts.output}`);
      console.log('═══════════════════════════════════════════');
      process.exit(0);
    }
  }

  process.on('SIGINT', () => { worker.shutdown(); setTimeout(finish, 1000); });
  process.on('SIGTERM', () => { worker.shutdown(); setTimeout(finish, 1000); });

  try {
    await worker.start();
  } catch (e) {
    console.error('Failed to start worker:', e);
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

function submitTasks(worker, dorks) {
  dorks.forEach((dork, i) => worker.submitTask({ task_id: `t${i}`, dork, page: 0 }));
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

function truncate(s, n) { return s.length > n ? s.slice(0, n - 3) + '...' : s; }

program.parse();
