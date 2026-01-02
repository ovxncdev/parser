/**
 * Anti-Public Filter
 * Filters out common public websites and tracks domains locally
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Default public domains to filter
const DEFAULT_PUBLIC_DOMAINS = [
  // Search engines
  'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'baidu.com', 'yandex.com',
  // Social media
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'tiktok.com',
  'pinterest.com', 'reddit.com', 'tumblr.com', 'snapchat.com', 'whatsapp.com',
  // Video/streaming
  'youtube.com', 'netflix.com', 'twitch.tv', 'vimeo.com', 'dailymotion.com', 'spotify.com',
  // E-commerce
  'amazon.com', 'ebay.com', 'alibaba.com', 'aliexpress.com', 'walmart.com', 'etsy.com',
  // Tech giants
  'microsoft.com', 'apple.com', 'adobe.com', 'oracle.com', 'ibm.com', 'salesforce.com',
  // Cloud providers
  'aws.amazon.com', 'cloud.google.com', 'azure.microsoft.com', 'digitalocean.com',
  // Dev platforms
  'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'npmjs.com',
  // News/media
  'cnn.com', 'bbc.com', 'nytimes.com', 'theguardian.com', 'reuters.com', 'forbes.com',
  // Email providers
  'gmail.com', 'outlook.com', 'mail.yahoo.com', 'protonmail.com',
  // Other common
  'wikipedia.org', 'wordpress.com', 'blogger.com', 'medium.com', 'quora.com',
  'dropbox.com', 'drive.google.com', 'docs.google.com', 'zoom.us', 'slack.com',
  // CDNs
  'cloudflare.com', 'akamai.com', 'fastly.com', 'jsdelivr.net', 'unpkg.com',
  // Ad networks
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
];

export interface AntiPublicOptions {
  enabled: boolean;
  useDatabase: boolean;
  databasePath: string;
  customBlacklist: string[];
  customWhitelist: string[];
  trackNewDomains: boolean;
  filterSubdomains: boolean;
}

const DEFAULT_OPTIONS: AntiPublicOptions = {
  enabled: true,
  useDatabase: true,
  databasePath: './state/domains.db',
  customBlacklist: [],
  customWhitelist: [],
  trackNewDomains: true,
  filterSubdomains: true,
};

export class AntiPublicFilter {
  private options: AntiPublicOptions;
  private publicDomains: Set<string>;
  private whitelist: Set<string>;
  private db: Database.Database | null = null;
  private stats = {
    filtered: 0,
    passed: 0,
    newDomains: 0,
    existingDomains: 0,
  };

  constructor(options: Partial<AntiPublicOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.publicDomains = new Set(DEFAULT_PUBLIC_DOMAINS);
    this.whitelist = new Set(this.options.customWhitelist);

    // Add custom blacklist
    for (const domain of this.options.customBlacklist) {
      this.publicDomains.add(domain.toLowerCase());
    }

    if (this.options.useDatabase) {
      this.initDatabase();
    }

    logger.debug('AntiPublicFilter initialized', {
      publicDomains: this.publicDomains.size,
      whitelist: this.whitelist.size,
      useDatabase: this.options.useDatabase,
    });
  }

  private initDatabase(): void {
    try {
      const dbDir = path.dirname(this.options.databasePath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(this.options.databasePath);
      this.db.pragma('journal_mode = WAL');

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS domains (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT UNIQUE NOT NULL,
          top_domain TEXT NOT NULL,
          first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
          hit_count INTEGER DEFAULT 1,
          source TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_domain ON domains(domain);
        CREATE INDEX IF NOT EXISTS idx_top_domain ON domains(top_domain);
      `);

      logger.debug('Domain database initialized', { path: this.options.databasePath });
    } catch (error) {
      logger.error('Failed to initialize domain database', { error });
      this.db = null;
    }
  }

  extractDomain(url: string): string | null {
    try {
      let urlToParse = url;
      if (!url.includes('://')) {
        urlToParse = 'http://' + url;
      }
      const parsed = new URL(urlToParse);
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  extractTopDomain(domain: string): string {
    const parts = domain.split('.');
    if (parts.length <= 2) return domain;

    // Handle common second-level TLDs
    const secondLevelTlds = [
      'co.uk', 'com.au', 'com.br', 'co.jp', 'co.kr', 'co.nz', 'co.za',
      'com.cn', 'com.mx', 'com.tw', 'org.uk', 'net.au', 'gov.uk',
    ];

    const lastTwo = parts.slice(-2).join('.');
    const lastThree = parts.slice(-3).join('.');

    for (const stld of secondLevelTlds) {
      if (lastTwo === stld || lastThree.endsWith('.' + stld)) {
        return parts.slice(-3).join('.');
      }
    }

    return parts.slice(-2).join('.');
  }

  isPublicDomain(domain: string): boolean {
    if (this.whitelist.has(domain)) return false;

    const topDomain = this.extractTopDomain(domain);

    // Check exact match
    if (this.publicDomains.has(domain)) return true;
    if (this.publicDomains.has(topDomain)) return true;

    // Check if subdomain of public domain
    if (this.options.filterSubdomains) {
      for (const publicDomain of this.publicDomains) {
        if (domain.endsWith('.' + publicDomain)) return true;
      }
    }

    return false;
  }

  isUrlPublic(url: string): boolean {
    const domain = this.extractDomain(url);
    if (!domain) return false;
    return this.isPublicDomain(domain);
  }

  trackDomain(domain: string, source?: string): boolean {
    if (!this.db || !this.options.trackNewDomains) return false;

    const topDomain = this.extractTopDomain(domain);

    try {
      const existing = this.db.prepare(
        'SELECT id, hit_count FROM domains WHERE domain = ?'
      ).get(domain) as { id: number; hit_count: number } | undefined;

      if (existing) {
        this.db.prepare(
          'UPDATE domains SET last_seen = CURRENT_TIMESTAMP, hit_count = hit_count + 1 WHERE id = ?'
        ).run(existing.id);
        this.stats.existingDomains++;
        return false;
      } else {
        this.db.prepare(
          'INSERT INTO domains (domain, top_domain, source) VALUES (?, ?, ?)'
        ).run(domain, topDomain, source || null);
        this.stats.newDomains++;
        return true;
      }
    } catch (error) {
      logger.error('Failed to track domain', { domain, error });
      return false;
    }
  }

  filterUrl(url: string, source?: string): { passed: boolean; domain: string | null; reason?: string } {
    const domain = this.extractDomain(url);

    if (!domain) {
      this.stats.filtered++;
      return { passed: false, domain: null, reason: 'invalid_url' };
    }

    if (this.isPublicDomain(domain)) {
      this.stats.filtered++;
      return { passed: false, domain, reason: 'public_domain' };
    }

    // Track the domain
    if (this.options.trackNewDomains) {
      this.trackDomain(domain, source);
    }

    this.stats.passed++;
    return { passed: true, domain };
  }

  filterUrls(urls: string[], source?: string): {
    passed: string[];
    filtered: string[];
    newDomains: string[];
    stats: { filtered: number; passed: number; newDomains: number; existingDomains: number };
  } {
    const passed: string[] = [];
    const filtered: string[] = [];
    const newDomains: string[] = [];

    for (const url of urls) {
      const result = this.filterUrl(url, source);
      if (result.passed) {
        passed.push(url);
        if (result.domain && this.stats.newDomains > 0) {
          newDomains.push(result.domain);
        }
      } else {
        filtered.push(url);
      }
    }

    return {
      passed,
      filtered,
      newDomains,
      stats: { ...this.stats },
    };
  }

  addPublicDomain(domain: string): void {
    this.publicDomains.add(domain.toLowerCase());
  }

  removePublicDomain(domain: string): void {
    this.publicDomains.delete(domain.toLowerCase());
  }

  addToWhitelist(domain: string): void {
    this.whitelist.add(domain.toLowerCase());
  }

  removeFromWhitelist(domain: string): void {
    this.whitelist.delete(domain.toLowerCase());
  }

  loadBlacklistFile(filePath: string): number {
    if (!fs.existsSync(filePath)) {
      logger.warn('Blacklist file not found', { path: filePath });
      return 0;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n')
      .map(line => line.trim().toLowerCase())
      .filter(line => line && !line.startsWith('#'));

    for (const domain of lines) {
      this.publicDomains.add(domain);
    }

    logger.info('Loaded blacklist file', { path: filePath, domains: lines.length });
    return lines.length;
  }

  getTrackedDomains(limit: number = 100, offset: number = 0): Array<{
    domain: string;
    topDomain: string;
    hitCount: number;
    firstSeen: string;
    lastSeen: string;
  }> {
    if (!this.db) return [];

    try {
      const rows = this.db.prepare(`
        SELECT domain, top_domain as topDomain, hit_count as hitCount, 
               first_seen as firstSeen, last_seen as lastSeen
        FROM domains
        ORDER BY hit_count DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset) as Array<{
        domain: string;
        topDomain: string;
        hitCount: number;
        firstSeen: string;
        lastSeen: string;
      }>;

      return rows;
    } catch (error) {
      logger.error('Failed to get tracked domains', { error });
      return [];
    }
  }

  searchDomains(query: string, limit: number = 50): Array<{ domain: string; hitCount: number }> {
    if (!this.db) return [];

    try {
      const rows = this.db.prepare(`
        SELECT domain, hit_count as hitCount
        FROM domains
        WHERE domain LIKE ?
        ORDER BY hit_count DESC
        LIMIT ?
      `).all(`%${query}%`, limit) as Array<{ domain: string; hitCount: number }>;

      return rows;
    } catch (error) {
      logger.error('Failed to search domains', { error });
      return [];
    }
  }

  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      filtered: 0,
      passed: 0,
      newDomains: 0,
      existingDomains: 0,
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
let antiPublicInstance: AntiPublicFilter | null = null;

export function getAntiPublicFilter(options?: Partial<AntiPublicOptions>): AntiPublicFilter {
  if (!antiPublicInstance) {
    antiPublicInstance = new AntiPublicFilter(options);
  }
  return antiPublicInstance;
}

export function resetAntiPublicFilter(): void {
  if (antiPublicInstance) {
    antiPublicInstance.close();
    antiPublicInstance = null;
  }
}

export default AntiPublicFilter;
