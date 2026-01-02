#!/usr/bin/env node

import { Command } from 'commander';
import { readFile, access, constants, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { DorkerUI, showBanner } from './ui.js';
import { WorkerIPC } from './ipc.js';
import { FilterPipeline } from './filters.js';
import { OutputWriter, formatNumber, formatDuration } from './output.js';

const require = createRequire(import.meta.url);
const inquirer = require('inquirer');

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
  .option('-d, --dorks <file>', 'Path to dorks file')
  .option('-p, --proxies <file>', 'Path to proxies file')
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

// Interactive start (default command)
program
  .command('start', { isDefault: true })
  .description('Start dorker interactively')
  .action(interactiveStart);

async function interactiveStart() {
  showBanner();
  
  // Find available files
  const inputDir = path.join(process.cwd(), '..', 'input');
  const currentDir = process.cwd();
  
  let dorkFiles = [];
  let proxyFiles = [];
  
  // Scan for dork files
  for (const dir of [inputDir, currentDir]) {
    if (existsSync(dir)) {
      try {
        const files = await readdir(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          if (file.includes('dork') || file.endsWith('.txt')) {
            dorkFiles.push({ name: `${file} (${dir})`, value: fullPath });
          }
          if (file.includes('prox') || file.includes('proxy')) {
            proxyFiles.push({ name: `${file} (${dir})`, value: fullPath });
          }
        }
      } catch (e) {}
    }
  }
  
  // Add manual entry options
  dorkFiles.push({ name: '[ Enter path manually ]', value: '__manual__' });
  proxyFiles.push({ name: '[ Enter path manually ]', value: '__manual__' });
  
  console.log('');
  
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'dorksFile',
      message: 'Select dorks file:',
      choices: dorkFiles,
      when: dorkFiles.length > 1
    },
    {
      type: 'input',
      name: 'dorksFileManual',
      message: 'Enter path to dorks file:',
      when: (ans) => ans.dorksFile === '__manual__' || dorkFiles.length === 1,
      validate: async (input) => {
        try {
          await access(input, constants.R_OK);
          return true;
        } catch {
          return 'File not found or not readable';
        }
      }
    },
    {
      type: 'list',
      name: 'proxiesFile',
      message: 'Select proxies file:',
      choices: proxyFiles,
      when: proxyFiles.length > 1
    },
    {
      type: 'input',
      name: 'proxiesFileManual',
      message: 'Enter path to proxies file:',
      when: (ans) => ans.proxiesFile === '__manual__' || proxyFiles.length === 1,
      validate: async (input) => {
        try {
          await access(input, constants.R_OK);
          return true;
        } catch {
          return 'File not found or not readable';
        }
      }
    },
    {
      type: 'number',
      name: 'workers',
      message: 'Number of workers:',
      default: 10,
      validate: (input) => input > 0 && input <= 100 ? true : 'Enter 1-100'
    },
    {
      type: 'list',
      name: 'outputFormat',
      message: 'Output format:',
      choices: [
        { name: 'Text (.txt)', value: 'txt' },
        { name: 'JSON (.json)', value: 'json' },
        { name: 'CSV (.csv)', value: 'csv' },
        { name: 'JSON Lines (.jsonl)', value: 'jsonl' }
      ],
      default: 'txt'
    },
    {
      type: 'confirm',
      name: 'antiPublic',
      message: 'Filter out public domains (google, facebook, etc)?',
      default: true
    },
    {
      type: 'confirm',
      name: 'domainDedup',
      message: 'Keep only one URL per domain?',
      default: true
    },
    {
      type: 'confirm',
      name: 'useUI',
      message: 'Use fancy terminal UI?',
      default: true
    },
    {
      type: 'confirm',
      name: 'startNow',
      message: 'Start dorking?',
      default: true
    }
  ]);
  
  if (!answers.startNow) {
    console.log('Cancelled.');
    process.exit(0);
  }
  
  // Resolve file paths
  const dorksFile = answers.dorksFileManual || answers.dorksFile;
  const proxiesFile = answers.proxiesFileManual || answers.proxiesFile;
  
  // Run with selected options
  await runCommand({
    dorks: dorksFile,
    proxies: proxiesFile,
    output: './output',
    workers: String(answers.workers),
    timeout: '30000',
    baseDelay: '8000',
    minDelay: '3000',
    maxDelay: '15000',
    maxRetries: '3',
    antiPublic: answers.antiPublic,
    dedup: true,
    domainDedup: answers.domainDedup,
    paramsOnly: false,
    ui: answers.useUI,
    format: answers.outputFormat
  });
}

async function runCommand(opts) {
  const startTime = Date.now();
  const useUI = opts.ui !== false && process.stdout.isTTY;

  // Validate files
  if (!opts.dorks || !opts.proxies) {
    console.error('Error: Dorks and proxies files are required');
    console.error('Use: dorker run -d <dorks.txt> -p <proxies.txt>');
    console.error('Or run: dorker (for interactive mode)');
    process.exit(1);
  }

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

  // Load proxies to show count
  const proxiesContent = await readFile(opts.proxies, 'utf-8');
  const proxies = proxiesContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

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
    console.log(`Dorks:   ${formatNumber(dorks.length)} loaded from ${path.basename(opts.dorks)}`);
    console.log(`Proxies: ${formatNumber(proxies.length)} loaded from ${path.basename(opts.proxies)}`);
    console.log(`Workers: ${opts.workers}`);
    console.log(`Output:  ${opts.output} (${opts.format})`);
    console.log('');
  }

  // State
  const state = {
    completed: 0,
    failed: 0,
    urlsRaw: 0,
    urlsFiltered: 0,
    lastStats: null,
    failedDorks: [],
    tasksSubmitted: false
  };

  // Worker events
  worker.on('status', (status, message) => {
    if (status === 'ready') {
      // Don't log ready, wait for initialized
    } else if (status === 'initialized') {
      log(ui, 'success', `Worker initialized with ${opts.workers} workers`);
      if (ui) ui.showRunning();

      if (!state.tasksSubmitted) {
        state.tasksSubmitted = true;
        worker.submitTasks(dorks);
        log(ui, 'info', `Submitted ${formatNumber(dorks.length)} tasks`);
      }
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
        ui.addActivity('error', dork, `→ ${error || status}`);
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
      const pct = progress.percentage.toFixed(1);
      const bar = '█'.repeat(Math.floor(progress.percentage / 5)) + '░'.repeat(20 - Math.floor(progress.percentage / 5));
      process.stdout.write(`\r[${bar}] ${pct}% | ${progress.current}/${progress.total} | ${state.urlsFiltered} URLs   `);
    }

    if (progress.current >= progress.total && progress.total > 0) {
      finish();
    }
  });

  worker.on('proxy_info', (info) => {
    if (ui) {
      ui.updateProxies(info.alive, info.dead, info.quarantined);
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

  // Start worker
  try {
    await worker.start();
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
