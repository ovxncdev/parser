/**
 * Interactive CLI
 * Arrow-key navigable menu system with prompts
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import figlet from 'figlet';
import fs from 'fs';
import path from 'path';
import { getDashboard } from './dashboard.js';
import { runCommand, validateCommand, checkProxiesCommand, estimateCommand, resumeCommand } from './commands.js';
import { getStateManager } from '../output/state.js';

// Menu choices
const MAIN_MENU_CHOICES = [
  { name: '🚀  Start New Scan', value: 'new_scan' },
  { name: '📊  Start with Live Dashboard', value: 'new_scan_dashboard' },
  { name: '⏸️   Resume Previous Scan', value: 'resume' },
  { name: '✅  Validate Files', value: 'validate' },
  { name: '🔍  Check Proxies', value: 'check_proxies' },
  { name: '⏱️   Estimate Time', value: 'estimate' },
  { name: '⚙️   Settings', value: 'settings' },
  { name: '📁  View Last Results', value: 'results' },
  { name: '❓  Help', value: 'help' },
  new inquirer.Separator(),
  { name: '🚪  Exit', value: 'exit' },
];

const STEALTH_PROFILES = [
  { name: 'Aggressive - Fast but risky (30 req/proxy/hr)', value: 'aggressive' },
  { name: 'Normal - Balanced (20 req/proxy/hr)', value: 'normal' },
  { name: 'Cautious - Slower, safer (10 req/proxy/hr)', value: 'cautious' },
  { name: 'Stealth - Very slow, very safe (5 req/proxy/hr)', value: 'stealth' },
];

const OUTPUT_FORMATS = [
  { name: 'TXT - Plain text (one URL per line)', value: 'txt', checked: true },
  { name: 'JSON - With metadata', value: 'json', checked: true },
  { name: 'CSV - Spreadsheet compatible', value: 'csv', checked: false },
  { name: 'SQLite - Database format', value: 'sqlite', checked: false },
];

function showBanner(): void {
  console.clear();
  console.log(
    chalk.cyan(
      figlet.textSync('DORKER', {
        font: 'ANSI Shadow',
        horizontalLayout: 'default',
      })
    )
  );
  console.log(chalk.gray('  High-Performance Google Dork Parser v1.0.0'));
  console.log(chalk.gray('  Hybrid Go/TypeScript Architecture\n'));
}

async function showMainMenu(): Promise<string> {
  const { choice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: 'What would you like to do?',
      choices: MAIN_MENU_CHOICES,
      pageSize: 12,
    },
  ]);
  return choice;
}

async function browseFile(message: string, defaultPath: string, extensions: string[]): Promise<string> {
  const { filePath } = await inquirer.prompt([
    {
      type: 'input',
      name: 'filePath',
      message,
      default: defaultPath,
      validate: (input: string) => {
        if (!input) return 'Please enter a file path';
        if (!fs.existsSync(input)) return `File not found: ${input}`;
        const ext = path.extname(input).toLowerCase();
        if (extensions.length > 0 && !extensions.includes(ext)) {
          return `Invalid file type. Expected: ${extensions.join(', ')}`;
        }
        return true;
      },
    },
  ]);
  return filePath;
}

async function newScanWizard(useDashboard: boolean = false): Promise<void> {
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                    NEW SCAN WIZARD'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  // Step 1: Dorks file
  console.log(chalk.yellow('Step 1/6: Select Dorks File\n'));
  const dorksFile = await browseFile('Path to dorks file:', './input/dorks.txt', ['.txt']);
  const dorksCount = fs.readFileSync(dorksFile, 'utf-8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#')).length;
  console.log(chalk.green(`  ✓ Loaded ${dorksCount.toLocaleString()} dorks\n`));

  // Step 2: Proxies file
  console.log(chalk.yellow('Step 2/6: Select Proxies File\n'));
  const proxiesFile = await browseFile('Path to proxies file:', './input/proxies.txt', ['.txt']);
  const proxiesCount = fs.readFileSync(proxiesFile, 'utf-8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#')).length;
  console.log(chalk.green(`  ✓ Loaded ${proxiesCount.toLocaleString()} proxies\n`));

  // Step 3: Output directory
  console.log(chalk.yellow('Step 3/6: Output Settings\n'));
  const { outputDir } = await inquirer.prompt([
    {
      type: 'input',
      name: 'outputDir',
      message: 'Output directory:',
      default: './output',
    },
  ]);

  // Step 4: Output formats
  const { formats } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'formats',
      message: 'Output formats:',
      choices: OUTPUT_FORMATS,
      validate: (input: string[]) => input.length > 0 || 'Select at least one format',
    },
  ]);

  // Step 5: Performance settings
  console.log(chalk.yellow('\nStep 4/6: Performance Settings\n'));
  
  const { workers } = await inquirer.prompt([
    {
      type: 'number',
      name: 'workers',
      message: 'Number of concurrent workers:',
      default: Math.min(100, proxiesCount),
      validate: (input: number) => {
        if (input < 1) return 'Minimum 1 worker';
        if (input > 500) return 'Maximum 500 workers';
        return true;
      },
    },
  ]);

  const { pagesPerDork } = await inquirer.prompt([
    {
      type: 'number',
      name: 'pagesPerDork',
      message: 'Pages to scrape per dork:',
      default: 5,
      validate: (input: number) => {
        if (input < 1) return 'Minimum 1 page';
        if (input > 20) return 'Maximum 20 pages';
        return true;
      },
    },
  ]);

  // Step 6: Stealth profile
  console.log(chalk.yellow('\nStep 5/6: Stealth Profile\n'));
  const { stealthProfile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'stealthProfile',
      message: 'Select stealth profile:',
      choices: STEALTH_PROFILES,
      default: 'normal',
    },
  ]);

  // Step 7: Filter settings
  console.log(chalk.yellow('\nStep 6/6: Filter Settings\n'));
  await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'filters',
      message: 'Enable filters:',
      choices: [
        { name: 'Remove duplicates', value: 'dedup', checked: true },
        { name: 'Anti-public filter (remove common sites)', value: 'antiPublic', checked: true },
        { name: 'URL params only (keep only URLs with ?params)', value: 'paramsOnly', checked: false },
        { name: 'Track domains in local DB', value: 'trackDomains', checked: true },
      ],
    },
  ]);

  // Show summary
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                    SCAN SUMMARY'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  
  console.log(`  ${chalk.bold('Dorks:')}          ${chalk.yellow(dorksCount.toLocaleString())} from ${dorksFile}`);
  console.log(`  ${chalk.bold('Proxies:')}        ${chalk.yellow(proxiesCount.toLocaleString())} from ${proxiesFile}`);
  console.log(`  ${chalk.bold('Workers:')}        ${chalk.yellow(workers)}`);
  console.log(`  ${chalk.bold('Pages/Dork:')}     ${chalk.yellow(pagesPerDork)}`);
  console.log(`  ${chalk.bold('Stealth:')}        ${chalk.yellow(stealthProfile)}`);
  console.log(`  ${chalk.bold('Output:')}         ${chalk.gray(outputDir)}`);
  console.log(`  ${chalk.bold('Formats:')}        ${chalk.gray(formats.join(', '))}`);
  
  // Estimate
  const totalRequests = dorksCount * pagesPerDork;
  const reqPerHour = stealthProfile === 'aggressive' ? 30 : 
                     stealthProfile === 'normal' ? 20 :
                     stealthProfile === 'cautious' ? 10 : 5;
  const effectiveProxies = Math.floor(proxiesCount * 0.5);
  const hoursNeeded = totalRequests / (effectiveProxies * reqPerHour);
  
  console.log(`\n  ${chalk.bold('Estimated Time:')} ${chalk.green(formatTime(hoursNeeded * 60))}`);
  console.log(`  ${chalk.bold('Total Requests:')} ${chalk.gray(totalRequests.toLocaleString())}`);

  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  // Confirm
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Start scan with these settings?',
      default: true,
    },
  ]);

  if (confirm) {
    const options = {
      dorks: dorksFile,
      proxies: proxiesFile,
      output: outputDir,
      threads: workers,
      pages: pagesPerDork,
      format: formats.join(','),
      verbose: false,
      quiet: false,
    };

    console.log('');
    
    if (useDashboard) {
      const dashboard = getDashboard();
      dashboard.init();
      dashboard.showInit({
        dorks: dorksCount,
        proxies: proxiesCount,
        workers,
        pagesPerDork,
      });
      (options as any).dashboard = dashboard;
    }
    
    await runCommand(options as any);
  } else {
    console.log(chalk.yellow('\nScan cancelled.\n'));
  }
}

async function resumeMenu(): Promise<void> {
  const stateManager = getStateManager();
  const resumeInfo = stateManager.getResumeInfo();

  if (!resumeInfo) {
    console.log(chalk.yellow('\n⚠  No previous session found to resume.\n'));
    await pause();
    return;
  }

  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                  PREVIOUS SESSION'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  console.log(`  ${chalk.bold('Session ID:')}    ${resumeInfo.sessionId}`);
  console.log(`  ${chalk.bold('Last Update:')}   ${new Date(resumeInfo.lastUpdate).toLocaleString()}`);
  console.log(`  ${chalk.bold('Completed:')}     ${chalk.green(resumeInfo.completed.toLocaleString())} dorks`);
  console.log(`  ${chalk.bold('Pending:')}       ${chalk.yellow(resumeInfo.pending.toLocaleString())} dorks`);
  console.log(`  ${chalk.bold('Failed:')}        ${chalk.red(resumeInfo.failed.toLocaleString())} dorks`);
  console.log(`  ${chalk.bold('URLs Found:')}    ${chalk.cyan(resumeInfo.urls.toLocaleString())}`);

  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: '▶️  Resume this session', value: 'resume' },
        { name: '🗑️  Delete and start fresh', value: 'delete' },
        { name: '↩️  Go back', value: 'back' },
      ],
    },
  ]);

  if (action === 'resume') {
    const { dorksFile, proxiesFile } = await inquirer.prompt([
      {
        type: 'input',
        name: 'dorksFile',
        message: 'Dorks file (for retry/new dorks):',
        default: './input/dorks.txt',
      },
      {
        type: 'input',
        name: 'proxiesFile',
        message: 'Proxies file:',
        default: './input/proxies.txt',
      },
    ]);

    const options = {
      dorks: dorksFile,
      proxies: proxiesFile,
      output: './output',
      resume: true,
    };

    await resumeCommand(options as any);
  } else if (action === 'delete') {
    const { confirmDelete } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmDelete',
        message: 'Are you sure? This will delete all progress.',
        default: false,
      },
    ]);

    if (confirmDelete) {
      stateManager.clear();
      console.log(chalk.green('\n✓ Session deleted.\n'));
    }
  }
}

async function validateMenu(): Promise<void> {
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                   VALIDATE FILES'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  const { validateType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'validateType',
      message: 'What would you like to validate?',
      choices: [
        { name: '📄  Dorks file', value: 'dorks' },
        { name: '🌐  Proxies file', value: 'proxies' },
        { name: '📄🌐 Both files', value: 'both' },
        { name: '↩️  Go back', value: 'back' },
      ],
    },
  ]);

  if (validateType === 'back') return;

  const options: { dorks?: string; proxies?: string } = {};

  if (validateType === 'dorks' || validateType === 'both') {
    options.dorks = await browseFile('Dorks file:', './input/dorks.txt', ['.txt']);
  }

  if (validateType === 'proxies' || validateType === 'both') {
    options.proxies = await browseFile('Proxies file:', './input/proxies.txt', ['.txt']);
  }

  console.log('');
  await validateCommand(options);
  await pause();
}

async function checkProxiesMenu(): Promise<void> {
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                   CHECK PROXIES'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  const proxiesFile = await browseFile('Proxies file:', './input/proxies.txt', ['.txt']);

  const { timeout, workers } = await inquirer.prompt([
    {
      type: 'number',
      name: 'timeout',
      message: 'Timeout per proxy (ms):',
      default: 10000,
    },
    {
      type: 'number',
      name: 'workers',
      message: 'Concurrent checks:',
      default: 50,
    },
  ]);

  console.log('');
  await checkProxiesCommand({ proxies: proxiesFile, timeout, workers });
  await pause();
}

async function estimateMenu(): Promise<void> {
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                  TIME ESTIMATE'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  const dorksFile = await browseFile('Dorks file:', './input/dorks.txt', ['.txt']);
  const proxiesFile = await browseFile('Proxies file:', './input/proxies.txt', ['.txt']);

  const { pages } = await inquirer.prompt([
    {
      type: 'number',
      name: 'pages',
      message: 'Pages per dork:',
      default: 5,
    },
  ]);

  console.log('');
  await estimateCommand({ dorks: dorksFile, proxies: proxiesFile, pages });
  await pause();
}

async function settingsMenu(): Promise<void> {
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                     SETTINGS'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  const settingsPath = './config/settings.json';
  
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'Settings options:',
      choices: [
        { name: '👁️  View current settings', value: 'view' },
        { name: '✏️  Edit settings file', value: 'edit' },
        { name: '🔄  Reset to defaults', value: 'reset' },
        { name: '↩️  Go back', value: 'back' },
      ],
    },
  ]);

  if (action === 'view') {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      console.log(chalk.gray('\nCurrent settings:\n'));
      console.log(JSON.stringify(settings, null, 2));
    } else {
      console.log(chalk.yellow('\nNo settings file found. Using defaults.\n'));
    }
    await pause();
  } else if (action === 'edit') {
    console.log(chalk.gray(`\nEdit the settings file at: ${settingsPath}\n`));
    await pause();
  } else if (action === 'reset') {
    console.log(chalk.yellow('\nReset functionality not yet implemented.\n'));
    await pause();
  }
}

async function viewResultsMenu(): Promise<void> {
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                   VIEW RESULTS'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  const outputDir = './output';
  
  if (!fs.existsSync(outputDir)) {
    console.log(chalk.yellow('No output directory found.\n'));
    await pause();
    return;
  }

  const folders = fs.readdirSync(outputDir)
    .filter(f => fs.statSync(path.join(outputDir, f)).isDirectory())
    .sort()
    .reverse()
    .slice(0, 10);

  if (folders.length === 0) {
    console.log(chalk.yellow('No results found.\n'));
    await pause();
    return;
  }

  const choices = folders.map(f => ({ name: `📁  ${f}`, value: f }));
  choices.push({ name: '↩️  Go back', value: 'back' });

  const { folder } = await inquirer.prompt([
    {
      type: 'list',
      name: 'folder',
      message: 'Select a result folder:',
      choices,
    },
  ]);

  if (folder === 'back') return;

  const resultPath = path.join(outputDir, folder);
  const files = fs.readdirSync(resultPath);

  console.log(chalk.gray(`\nFiles in ${folder}:\n`));
  for (const file of files) {
    const stats = fs.statSync(path.join(resultPath, file));
    const size = (stats.size / 1024).toFixed(1) + ' KB';
    console.log(`  ${file.padEnd(20)} ${chalk.gray(size)}`);
  }

  const statsPath = path.join(resultPath, 'stats.json');
  if (fs.existsSync(statsPath)) {
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(`  ${chalk.bold('Total URLs:')}      ${stats.totalUrls?.toLocaleString() || 'N/A'}`);
    console.log(`  ${chalk.bold('Unique URLs:')}     ${stats.uniqueUrls?.toLocaleString() || 'N/A'}`);
    console.log(`  ${chalk.bold('Domains:')}         ${stats.uniqueDomains?.toLocaleString() || 'N/A'}`);
    console.log(`  ${chalk.bold('Duration:')}        ${formatTime(stats.duration / 60000) || 'N/A'}`);
  }

  console.log('');
  await pause();
}

async function showHelp(): Promise<void> {
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('                       HELP'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  console.log(chalk.bold('COMMANDS:\n'));
  console.log('  🚀  Start New Scan     - Configure and run a new dork scan');
  console.log('  ⏸️   Resume             - Continue a previously paused scan');
  console.log('  ✅  Validate           - Check dorks/proxies file format');
  console.log('  🔍  Check Proxies      - Test proxy connectivity');
  console.log('  ⏱️   Estimate           - Calculate estimated completion time\n');

  console.log(chalk.bold('FILE FORMATS:\n'));
  console.log('  Dorks:    One dork per line (# for comments)');
  console.log('  Proxies:  ip:port or ip:port:user:pass\n');

  console.log(chalk.bold('TIPS:\n'));
  console.log('  • Use more proxies for faster scanning');
  console.log('  • Lower stealth profile = faster but riskier');
  console.log('  • Enable anti-public filter to skip common sites');
  console.log('  • Progress is auto-saved every 30 seconds\n');

  console.log(chalk.bold('KEYBOARD SHORTCUTS:\n'));
  console.log('  ↑/↓       Navigate menus');
  console.log('  Enter     Select option');
  console.log('  Ctrl+C    Exit/Cancel\n');

  await pause();
}

async function pause(): Promise<void> {
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: 'Press Enter to continue...',
    },
  ]);
}

function formatTime(minutes: number): string {
  if (minutes < 60) {
    return `${Math.ceil(minutes)} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.ceil(minutes % 60);
  return `${hours}h ${mins}m`;
}

export async function startInteractive(): Promise<void> {
  let running = true;

  while (running) {
    showBanner();
    const choice = await showMainMenu();

    switch (choice) {
      case 'new_scan':
        await newScanWizard(false);
        break;
      case 'new_scan_dashboard':
        await newScanWizard(true);
        break;
      case 'resume':
        await resumeMenu();
        break;
      case 'validate':
        await validateMenu();
        break;
      case 'check_proxies':
        await checkProxiesMenu();
        break;
      case 'estimate':
        await estimateMenu();
        break;
      case 'settings':
        await settingsMenu();
        break;
      case 'results':
        await viewResultsMenu();
        break;
      case 'help':
        await showHelp();
        break;
      case 'exit':
        running = false;
        console.log(chalk.gray('\nGoodbye! 👋\n'));
        break;
    }
  }
}

export default startInteractive;
