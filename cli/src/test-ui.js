
#!/usr/bin/env node
import { DorkerUI } from './ui.js';

const ui = new DorkerUI();
ui.init();

// Simulate initialization
ui.showInitPhase();

setTimeout(() => {
  ui.addActivity('info', 'Loading configuration...', 'OK');
}, 500);

setTimeout(() => {
  ui.addActivity('success', 'Dorks loaded', '400,000 queries');
}, 1000);

setTimeout(() => {
  ui.addActivity('info', 'Testing proxies...', '0/2000');
}, 1500);

// Simulate proxy check complete
setTimeout(() => {
  ui.showProxyReport(2000, 1642, 241, 117);
  ui.updateProxies(1642, 241, 117);
}, 3000);

// Wait for Enter then start running
ui.screen.key(['enter'], () => {
  ui.showRunning();
  
  // Simulate progress
  let current = 0;
  const total = 400000;
  let elapsed = 0;
  
  const interval = setInterval(() => {
    current += Math.floor(Math.random() * 500) + 200;
    elapsed += 1000;
    
    if (current > total) current = total;
    
    const rate = current / (elapsed / 1000);
    const eta = rate > 0 ? ((total - current) / rate) * 1000 : 0;
    
    ui.updateProgress(current, total);
    ui.updateTiming(elapsed, eta);
    ui.updateThroughput(Math.random() * 30 + 15);
    
    ui.updateStats({
      requestsPerMin: Math.floor(Math.random() * 200) + 1100,
      successRate: 92 + Math.random() * 6,
      activeProxies: 1583 + Math.floor(Math.random() * 20) - 10,
      urlsFound: Math.floor(current * 2.1),
      uniqueDomains: Math.floor(current * 0.3)
    });
    
    ui.updateResults(
      Math.floor(current * 2.1),
      Math.floor(current * 1.4),
      Math.floor(current * 0.3)
    );
    
    // Random activity
    const dorks = [
      'inurl:admin site:*.edu',
      'filetype:sql password',
      'intitle:index.of',
      'ext:php id=',
      'inurl:login',
      'filetype:pdf confidential'
    ];
    const types = ['success', 'success', 'success', 'success', 'warning', 'error'];
    const type = types[Math.floor(Math.random() * types.length)];
    const dork = dorks[Math.floor(Math.random() * dorks.length)];
    const urls = type === 'success' ? `→ ${Math.floor(Math.random() * 150) + 10} URLs` 
               : type === 'warning' ? '→ CAPTCHA, rotating'
               : '→ Timeout';
    ui.addActivity(type, dork, urls);
    
    if (current >= total) {
      clearInterval(interval);
      setTimeout(() => {
        ui.showComplete({
          totalDorks: 400000,
          duration: elapsed,
          totalRequests: 412847,
          successRate: 93.8,
          rawUrls: 2847291,
          afterDedup: 1284847,
          afterFilter: 847291,
          finalDomains: 284847,
          outputDir: './output/2024-01-15/'
        });
      }, 1000);
    }
  }, 100);
});

// Handle pause/resume
ui.setCallbacks({
  onPause: () => {
    ui.showPaused();
    ui.addActivity('warning', 'User paused', 'Waiting...');
  },
  onResume: () => {
    ui.showRunning();
    ui.addActivity('info', 'Resumed', 'Continuing...');
  },
  onQuit: () => {
    ui.exit();
  }
});
