import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export class OutputWriter {
  constructor(options = {}) {
    this.options = {
      directory: './output',
      prefix: 'dorker',
      format: 'txt',  // txt, json, csv, jsonl
      splitByDork: false,
      ...options
    };

    this.streams = new Map();
    this.files = [];
    this.counts = {
      urls: 0,
      domains: 0
    };

    // Create output directory
    const dateDir = new Date().toISOString().split('T')[0];
    this.outputDir = path.join(this.options.directory, dateDir);
    
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  getStream(name) {
    if (this.streams.has(name)) {
      return this.streams.get(name);
    }

    const ext = this.options.format === 'jsonl' ? 'jsonl' : this.options.format;
    const filename = `${this.options.prefix}_${name}.${ext}`;
    const filepath = path.join(this.outputDir, filename);
    
    const stream = createWriteStream(filepath, { flags: 'a' });
    this.streams.set(name, stream);
    this.files.push(filepath);
    
    return stream;
  }

  formatLine(url, metadata = {}) {
    switch (this.options.format) {
      case 'json':
      case 'jsonl':
        return JSON.stringify({ url, ...metadata });
      case 'csv':
        const dork = (metadata.dork || '').replace(/"/g, '""');
        return `"${url}","${dork}","${metadata.timestamp || ''}"`;
      default:
        return url;
    }
  }

  writeUrl(url, metadata = {}) {
    const stream = this.getStream('results');
    stream.write(this.formatLine(url, metadata) + '\n');
    this.counts.urls++;
  }

  writeUrls(urls, dork = '') {
    const stream = this.getStream('results');
    const timestamp = Date.now();
    
    for (const url of urls) {
      stream.write(this.formatLine(url, { dork, timestamp }) + '\n');
      this.counts.urls++;
    }
  }

  writeDomain(domain) {
    const stream = this.getStream('domains');
    stream.write(domain + '\n');
    this.counts.domains++;
  }

  writeDomains(domains) {
    const stream = this.getStream('domains');
    for (const domain of domains) {
      stream.write(domain + '\n');
      this.counts.domains++;
    }
  }

  writeRaw(url) {
    const stream = this.getStream('raw');
    stream.write(url + '\n');
  }

  writeWithParams(url) {
    const stream = this.getStream('urls-with-params');
    stream.write(url + '\n');
  }

  async writeFailedDorks(dorks) {
    const filepath = path.join(this.outputDir, `${this.options.prefix}_failed.txt`);
    await writeFile(filepath, dorks.join('\n'), 'utf-8');
    this.files.push(filepath);
  }

  async writeSummary(stats) {
    const summary = {
      timestamp: new Date().toISOString(),
      duration: stats.duration,
      dorks: {
        total: stats.totalDorks,
        completed: stats.completed,
        failed: stats.failed
      },
      urls: {
        raw: stats.rawUrls,
        filtered: stats.filteredUrls,
        domains: stats.uniqueDomains
      },
      proxies: {
        total: stats.proxiesTotal,
        alive: stats.proxiesAlive
      },
      performance: {
        requestsPerMin: stats.requestsPerMin,
        successRate: stats.successRate
      },
      files: this.files
    };

    const filepath = path.join(this.outputDir, `${this.options.prefix}_summary.json`);
    await writeFile(filepath, JSON.stringify(summary, null, 2), 'utf-8');
    this.files.push(filepath);
  }

  async close() {
    const closePromises = [];
    
    for (const [name, stream] of this.streams) {
      closePromises.push(new Promise((resolve, reject) => {
        stream.end((err) => {
          if (err) reject(err);
          else resolve();
        });
      }));
    }

    await Promise.all(closePromises);
    this.streams.clear();
  }

  getOutputDir() {
    return this.outputDir;
  }

  getFiles() {
    return this.files;
  }

  getCounts() {
    return { ...this.counts };
  }
}

// ─────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────

export function formatNumber(num) {
  return num.toLocaleString();
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default OutputWriter;
