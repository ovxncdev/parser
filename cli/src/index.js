#!/usr/bin/env node

import { Command } from 'commander';
import { readFile, access, constants, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import inquirer from 'inquirer';

import { DorkerUI, showBanner } from './ui.js';
import { WorkerIPC } from './ipc.js';
import { FilterPipeline } from './filters.js';
import { OutputWriter, formatNumber, formatDuration } from './output.js';

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERSION = '1.0.0';
const program = new Command();

program
  .name('dorker')
  .description('High-performance Google Dork parser')
  .version(VERSION);

// Interactive mode (default)
program
  .command('start', { isDefault: true })
  .description('Start dorker interactively')
  .action(interactiveStart);

program
  .command('run')
  .description('Run dorker with command line arguments')
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

// ─────────────────────────────────────────────────────────────
// Interactive Mode - User Friendly
// ─────────────────────────────────────────────────────────────

async function interactiveStart() {
  console.clear();
  showBanner();
  
  console.log('  Welcome to Dorker! Let\'s get started.\n');
  
  // Scan for files in common locations
  const searchDirs = [
    path.resolve(process.cwd(), '..', 'input'),
    path.resolve(process.cwd(), 'input'),
    process.cwd(),
  ];
  
  const dorkFiles = [];
  const proxyFiles = [];
  
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        if (!file.endsWith('.txt')) continue;
        
        const fullPath = path.join(dir, file);
        const displayName = path.relative(process.cwd(), fullPath);
        
        // Count lines
        try {
          const content = await readFile(fullPath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
          
          if (file.toLowerCase().includes('dork')) {
            dorkFiles.push({ 
              name: `${displayName} (${formatNumber(lines)} dorks)`, 
              value: fullPath,
              lines 
            });
          }
          if (file.toLowerCase().includes('prox')) {
            proxyFiles.push({ 
              name: `${displayName} (${formatNumber(lines)} proxies)`, 
              value: fullPath,
              lines 
            });
          }
        } catch {}
      }
    } catch {}
  }
  
  // Add manual entry option
  dorkFiles.push({ name: '📁 Browse / Enter path manually...', value: '__manual__' });
  proxyFiles.push({ name: '📁 Browse / Enter path manually...', value: '__manual__' });
  
  // If no files found, show helpful message
  if (dorkFiles.length === 1) {
    console.log('  ⚠️  No dork files found. Create one in the input/ folder.\n');
  }
  if (proxyFiles.length === 1) {
    console.log('  ⚠️  No proxy files found. Create one in the input/ folder.\n');
  }

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'dorksFile',
      message: '📄 Select your dorks file:',
      choices: dorkFiles,
      pageSize: 10
    },
    {
      type: 'input',
      name: 'dorksManual',
      message: '   Enter full path to dorks file:',
      when: (ans) => ans.dorksFile === '__manual__',
      validate: async (input) => {
        if (!input.trim()) return 'Please enter a path';
        const resolved = path.resolve(input);
        try {
          await access(resolved, constants.R_OK);
          return true;
        } catch {
          return `File not found: ${resolved}`;
        }
      }
    },
    {
      type: 'list',
      name: 'proxiesFile',
      message: '🌐 Select your proxies file:',
      choices: proxyFiles,
      pageSize: 10
    },
    {
      type: 'input',
      name: 'proxiesManual',
      message: '   Enter full path to proxies file:',
      when: (ans) => ans.proxiesFile === '__manual__',
      validate: async (input) => {
        if (!input.trim()) return 'Please enter a path';
        const resolved = path.resolve(input);
        try {
          await access(resolved, constants.R_OK);
          return true;
        } catch {
          return `File not found: ${resolved}`;
        }
      }
    },
    {
      type: 'list',
      name: 'workers',
      message: '⚡ How many concurrent workers?',
      choices: [
        { name: '5  (Slow & Safe)', value: 5 },
        { name: '10 (Recommended)', value: 10 },
        { name: '20 (Fast)', value: 20 },
        { name: '50 (Aggressive)', value: 50 },
        { name: 'Custom...', value: '__custom__' }
      ],
      default: 1
    },
    {
      type: 'number',
      name: 'workersCustom',
      message: '   Enter number of workers (1-100):',
      when: (ans) => ans.workers === '__custom__',
      default: 10,
      validate: (n) => (n > 0 && n <= 100) ? true : 'Enter a number between 1 and 100'
    },
    {
      type: 'list',
      name: 'format',
      message: '📝 Output format:',
      choices: [
        { name: 'Plain Text (.txt) - One URL per line', value: 'txt' },
        { name: 'JSON (.json) - Structured data', value: 'json' },
        { name: 'CSV (.csv) - Spreadsheet compatible', value: 'csv' },
        { name: 'JSON Lines (.jsonl) - Streaming JSON', value: 'jsonl' }
      ],
      default: 0
    },
    {
      type: 'confirm',
      name: 'antiPublic',
      message: '🛡️  Filter out common public sites (Google, Facebook, etc)?',
      default: true
    },
    {
      type: 'confirm',
      name: 'domainDedup',
      message: '🔗 Keep only one URL per domain (removes duplicates)?',
      default: true
    },
    {
      type: 'list',
      name: 'uiMode',
      message: '🎨 Display mode:',
      choices: [
        { name: 'Fancy Dashboard (Live stats, graphs)', value: 'fancy' },
        { name: 'Simple Console (Minimal output)', value: 'simple' }
      ],
      default: 0
    },
    {
      type: 'confirm',
      name: 'startNow',
      message: '🚀 Ready to start?',
      default: true
    }
  ]);

  if (!answers.startNow) {
    console.log('\n  👋 Cancelled. Run again when ready!\n');
    process.exit(0);
  }

  // Resolve paths
  const dorksFile = answers.dorksManual ? path.resolve(answers.dorksManual) : answers.dorksFile;
  const proxiesFile = answers.proxiesManual ? path.resolve(answers.proxiesManual) : answers.proxiesFile;
  const workers = answers.workersCustom || answers.workers;
  const useUI = answers.uiMode === 'fancy';

  // Show summary
  console.log('\n  ───────────────────────────────────────');
  console.log('  📋 Configuration Summary:');
  console.log('  ───────────────────────────────────────');
  
  const dorksContent = await readFile(dorksFile, 'utf-8');
  const dorkCount = dorksContent.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
  
  const proxiesContent = await readFile(proxiesFile, 'utf-8');
  const proxyCount = proxiesContent.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;

  console.log(`  Dorks:     ${formatNumber(dorkCount)}`);
  console.log(`  Proxies:   ${formatNumber(proxyCount)}`);
  console.log(`  Workers:   ${workers}`);
  console.log(`  Format:    ${answers.format}`);
  console.log(`  Filters:   ${answers.antiPublic ? 'Anti-public' : ''} ${answers.domainDedup ? 'Domain-dedup' : ''}`.trim() || 'None');
  console.log('  ───────────────────────────────────────\n');

  if (proxyCount === 0) {
    console.log('  ❌ No proxies found in file! Add proxies first.\n');
    process.exit(1);
  }

  // Small delay for user to read
  await new Promise(r => setTimeout(r, 1000));

  // Run
  await runCommand({
    dorks: dorksFile,
    proxies: proxiesFile,
    output: './output',
    workers: String(workers),
    timeout: '30000',
    baseDelay: '8000',
    minDelay: '3000',
    maxDelay: '15000',
    maxRetries: '3',
    antiPublic: answers.antiPublic,
    dedup: true,
    domainDedup: answers.domainDedup,
    paramsOnly: false,
    ui: useUI,
    format: answers.format
  });
}

// ─────────────────────────────────────────────────────────────
// Run Command
// ─────────────────────────────────────────────────────────────

async function runCommand(opts) {
  const startTime = Date.now();
  const useUI = opts.ui !== false && process.stdout.isTTY;

  if (!opts.dorks || !opts.proxies) {
    console.error('\n  ❌ Error: Dorks and proxies files required\n');
    console.error('  Usage: dorker run -d <dorks.txt> -p <proxies.txt>');
    console.error('  Or just run: dorker (for interactive mode)\n');
    process.exit(1);
  }

  try {
    await access(opts.dorks, constants.R_OK);
    await access(opts.proxies, constants.R_OK);
  } catch {
    console.error('\n  ❌ Error: Cannot read dorks or proxies file\n');
    process.exit(1);
  }

  const workerPath = findWorker();
  if (!workerPath) {
    console.error('\n  ❌ Error: Worker binary not found');
    console.error('  Run: ./setup.sh to build it\n');
    process.exit(1);
  }

  const dorksContent = await readFile(opts.dorks, 'utf-8');
  const dorks = dorksContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  if (dorks.length === 0) {
    console.error('\n  ❌ Error: No dorks found in file\n');
    process.exit(1);
  }

  if (!existsSync(opts.output)) {
    mkdirSync(opts.output, { recursive: true });
  }

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

  let ui = null;
  if (useUI) {
    ui = new DorkerUI();
    ui.init();
    ui.showInitPhase();
  } else {
    showBanner();
    console.log(`  Dorks:   ${formatNumber(dorks.length)}`);
    console.log(`  Workers: ${opts.workers}`);
    console.log('');
  }

  const state = {
    completed: 0,
    failed: 0,
    urlsRaw: 0,
    urlsFiltered: 0,
    lastStats: null,
    failedDorks: [],
    tasksSubmitted: false
  };

  worker.on('status', (status, message) => {
    if (status === 'initialized') {
      if (ui) {
        ui.addActivity('success', '', `Worker ready (${opts.workers} workers)`);
        ui.showRunning();
      } else {
        console.log(`  ✓ Worker initialized`);
      }

      if (!state.tasksSubmitted) {
        state.tasksSubmitted = true;
        worker.submitTasks(dorks);
      }
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

      if (ui) ui.addActivity('success', dork, `→ ${urls.length} URLs`);
    } else {
      state.failed++;
      state.failedDorks.push(dork);
      if (ui) ui.addActivity('error', dork, `→ ${error || status}`);
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
      const filled = Math.floor(progress.percentage / 5);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      process.stdout.write(`\r  [${bar}] ${pct}% | ${progress.current}/${progress.total} | ${state.urlsFiltered} URLs `);
    }

    if (progress.current >= progress.total && progress.total > 0) {
      finish();
    }
  });

  worker.on('proxy_info', (info) => {
    if (ui) ui.updateProxies(info.alive, info.dead, info.quarantined);
  });

  worker.on('error', (code, message) => {
    if (ui) ui.addActivity('error', '', `[${code}] ${message}`);
    else console.log(`\n  ✗ Error: [${code}] ${message}`);
  });

  worker.on('close', (code) => {
    if (code !== 0 && code !== null) {
      if (ui) ui.addActivity('error', '', `Worker crashed (code ${code})`);
      else console.log(`\n  ✗ Worker exited: ${code}`);
    }
    finish();
  });

  if (ui) {
    ui.setCallbacks({
      onPause: () => worker.pause(),
      onResume: () => worker.resume(),
      onQuit: () => { worker.shutdown(); setTimeout(finish, 1000); }
    });
  }

  const statsInterval = setInterval(() => {
    if (worker.isConnected()) worker.getStats();
  }, 1000);

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
      console.log('\n\n');
      console.log('  ═══════════════════════════════════════════════════════════');
      console.log('                          ✓ COMPLETE');
      console.log('  ═══════════════════════════════════════════════════════════');
      console.log(`   Duration:  ${formatDuration(duration)}`);
      console.log(`   Dorks:     ${state.completed} completed, ${state.failed} failed`);
      console.log(`   URLs:      ${formatNumber(state.urlsFiltered)} saved`);
      console.log(`   Domains:   ${formatNumber(filterStats.uniqueDomains)} unique`);
      console.log(`   Output:    ${output.getOutputDir()}`);
      console.log('  ═══════════════════════════════════════════════════════════\n');
      process.exit(0);
    }
  }

  process.on('SIGINT', () => { worker.shutdown(); setTimeout(finish, 1000); });
  process.on('SIGTERM', () => { worker.shutdown(); setTimeout(finish, 1000); });

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
    if (ui) ui.addActivity('error', '', `Failed: ${err.message}`);
    else console.error(`\n  ❌ Failed to start: ${err.message}\n`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// Validate Command
// ─────────────────────────────────────────────────────────────

async function validateCommand(opts) {
  showBanner();
  console.log('  Validating files...\n');

  for (const [name, file] of [['Dorks', opts.dorks], ['Proxies', opts.proxies]]) {
    console.log(`  ${name}: ${file}`);
    try {
      await access(file, constants.R_OK);
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      console.log(`    ✓ ${formatNumber(lines.length)} entries\n`);
    } catch {
      console.log('    ✗ Cannot read file\n');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function findWorker() {
  const paths = [
    path.join(process.cwd(), 'bin', 'worker'),
    path.join(process.cwd(), '..', 'bin', 'worker'),
    path.join(__dirname, '..', '..', 'bin', 'worker'),
    path.join(__dirname, '..', '..', '..', 'bin', 'worker'),
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

program.parse();
