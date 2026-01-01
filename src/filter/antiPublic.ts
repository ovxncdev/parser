/**
 * Anti-Public Filter
 * Filters out common public sites and tracks scraped domains in local database
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { extractDomain, extractTopDomain, normalizeDomain, matchesDomainPattern } from './domain.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Default public domains to filter
const DEFAULT_PUBLIC_DOMAINS = [
  // Social Media
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com',
  'tiktok.com', 'youtube.com', 'pinterest.com', 'reddit.com', 'tumblr.com',
  'snapchat.com', 'whatsapp.com', 'telegram.org', 'discord.com', 'twitch.tv',
  'vk.com', 'weibo.com', 'quora.com', 'medium.com',

  // Search Engines
  'google.com', 'bing.com', 'yahoo.com', 'yandex.com', 'baidu.com',
  'duckduckgo.com', 'ask.com', 'aol.com',

  // E-Commerce
  'amazon.com', 'ebay.com', 'etsy.com', 'aliexpress.com', 'alibaba.com',
  'walmart.com', 'target.com', 'shopify.com',

  // Tech Giants
  'apple.com', 'microsoft.com', 'adobe.com', 'oracle.com', 'ibm.com',
  'salesforce.com', 'cisco.com', 'intel.com', 'nvidia.com',

  // Dev Platforms
  'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com',
  'npmjs.com', 'pypi.org', 'codepen.io', 'jsfiddle.net',

  // Cloud/Hosting
  'cloudflare.com', 'amazonaws.com', 'azure.com', 'digitalocean.com',
  'heroku.com', 'netlify.com', 'vercel.com',

  // CMS/Blogs
  'wordpress.com', 'wordpress.org', 'blogger.com', 'wix.com',
  'squarespace.com', 'weebly.com', 'ghost.org', 'substack.com',

  // Reference
  'wikipedia.org', 'wikimedia.org', 'britannica.com', 'dictionary.com',

  // Streaming
  'netflix.com', 'hulu.com', 'spotify.com', 'twitch.tv', 'vimeo.com',

  // News (Major)
  'nytimes.com', 'washingtonpost.com', 'bbc.com', 'cnn.com', 'reuters.com',
  'theguardian.com', 'forbes.com', 'bloomberg.com',

  // Google Properties
  'googleapis.com', 'googleusercontent.com', 'gstatic.com', 'google-analytics.com',
  'googlesyndication.com', 'googleadservices.com', 'doubleclick.net',

  // Misc Public
  'archive.org', 'imdb.com', 'yelp.com', 'tripadvisor.com',
  'booking.com', 'airbnb.com', 'uber.com', 'paypal.com',
];

// Anti-public filter options
export interface AntiPublicOptions {
  enabled: boolean;
  domains: string[];
  localDb: boolean;
  dbPath: string;
  trackNew: boolean;
  filterSubdomains: boolean;
}

const DEFAULT_OPTIONS: AntiPublicOptions = {
  enabled: true,
  domains: DEFAULT_PUBLIC_DOMAINS,
  localDb: true,
  dbPath: './state/domains.db',
  trackNew: true,
  filterSubdomains: true,
};

/**
 * Anti-Public Filter with local database tracking
 */
export class AntiPublicFilter {
  private options: AntiPublicOptions;
  private publicDomains: Set<string>;
  private db: Database.Database | null = null;
  private insertStmt: Database.Statement | null = null;
  private checkStmt: Database.Statement | null = null;
  private stats = {
    filtered: 0,
    passed: 0,
    newDomains: 0,
    existingDomains: 0,
  };

  constructor(options: Partial<AntiPublicOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.publicDomains = new Set(this.options.domains.map(d => normalizeDomain(d)));

    if (this.options.localDb) {
      this.initDatabase();
    }

    logger.debug('AntiPublic filter initialized', {
      publicDomains: this.publicDomains.size,
      localDb: this.options.localDb,
    });
  }

  /**
   * Initialize SQLite database for domain tracking
   */
  private initDatabase(): void {
    try {
      // Ensure directory exists
      const dbDir = path.dirname(this.options.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(this.options.dbPath);

      // Create tables
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
        CREATE INDEX IF NOT EXISTS idx_first_seen ON domains(first_seen);
      `);

      // Prepare statements
      this.insertStmt = this.db.prepare(`
        INSERT INTO domains (domain, top_domain, source)
        VALUES (?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          last_seen = CURRENT_TIMESTAMP,
          hit_count = hit_count + 1
      `);

      this.checkStmt = this.db.prepare(`
        SELECT id, hit_count FROM domains WHERE domain = ?
      `);

      logger.info('AntiPublic database initialized', { path: this.options.dbPath });
    } catch (error) {
      logger.error('Failed to initialize AntiPublic database', { error });
      this.db = null;
    }
  }

  /**
   * Check if domain is in public list
   */
  isPublicDomain(domain: string): boolean {
    const normalized = normalizeDomain(domain);
    const topDomain = extractTopDomain('http://' + domain) || domain;
    const normalizedTop = normalizeDomain(topDomain);

    // Check exact match
    if (this.publicDomains.has(normalized)) {
      return true;
    }

    // Check top domain
    if (this.publicDomains.has(normalizedTop)) {
      return true;
    }

    // Check subdomain filtering
    if (this.options.filterSubdomains) {
      for (const publicDomain of this.publicDomains) {
        if (matchesDomainPattern(normalized, '*.' + publicDomain)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if domain exists in local database
   */
  isDomainInDb(domain: string): boolean {
    if (!this.db || !this.checkStmt) {
      return false;
    }

    const normalized = normalizeDomain(domain);
    const result = this.checkStmt.get(normalized) as { id: number; hit_count: number } | undefined;
    return !!result;
  }

  /**
   * Add domain to local database
   */
  addDomainToDb(domain: string, source?: string): boolean {
    if (!this.db || !this.insertStmt) {
      return false;
    }

    try {
      const normalized = normalizeDomain(domain);
      const topDomain = extractTopDomain('http://' + domain) || domain;

      this.insertStmt.run(normalized, normalizeDomain(topDomain), source || 'scrape');
      return true;
    } catch (error) {
      logger.error('Failed to add domain to database', { domain, error });
      return false;
    }
  }

  /**
   * Filter a single URL
   */
  filterUrl(url: string, source?: string): {
    passed: boolean;
    domain: string | null;
    reason?: string;
    isNew?: boolean;
  } {
    if (!this.options.enabled) {
      return { passed: true, domain: null };
    }

    const domain = extractDomain(url);
    if (!domain) {
      this.stats.filtered++;
      return { passed: false, domain: null, reason: 'invalid_url' };
    }

    // Check public domain list
    if (this.isPublicDomain(domain)) {
      this.stats.filtered++;
      return { passed: false, domain, reason: 'public_domain' };
    }

    // Check local database
    let isNew = true;
    if (this.options.localDb && this.isDomainInDb(domain)) {
      this.stats.existingDomains++;
      isNew = false;
    } else {
      this.stats.newDomains++;
    }

    // Track domain if enabled
    if (this.options.trackNew && this.options.localDb) {
      this.addDomainToDb(domain, source);
    }

    this.stats.passed++;
    return { passed: true, domain, isNew };
  }

  /**
   * Filter multiple URLs
   */
  filterUrls(urls: string[], source?: string): {
    passed: string[];
    filtered: string[];
    newDomains: string[];
    stats: typeof this.stats;
  } {
    const passed: string[] = [];
    const filtered: string[] = [];
    const newDomains: string[] = [];
    const seenDomains = new Set<string>();

    for (const url of urls) {
      const result = this.filterUrl(url, source);

      if (result.passed) {
        passed.push(url);

        if (result.domain && result.isNew && !seenDomains.has(result.domain)) {
          seenDomains.add(result.domain);
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

  /**
   * Add custom public domain
   */
  addPublicDomain(domain: string): void {
    this.publicDomains.add(normalizeDomain(domain));
  }

  /**
   * Add multiple public domains
   */
  addPublicDomains(domains: string[]): void {
    for (const domain of domains) {
      this.addPublicDomain(domain);
    }
  }

  /**
   * Remove public domain
   */
  removePublicDomain(domain: string): boolean {
    return this.publicDomains.delete(normalizeDomain(domain));
  }

  /**
   * Load public domains from file
   */
  loadPublicDomainsFromFile(filePath: string): number {
    if (!fs.existsSync(filePath)) {
      logger.warn('Public domains file not found', { path: filePath });
      return 0;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let count = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        this.addPublicDomain(trimmed);
        count++;
      }
    }

    logger.info('Loaded public domains from file', { path: filePath, count });
    return count;
  }

  /**
   * Get all tracked domains from database
   */
  getTrackedDomains(limit: number = 1000, offset: number = 0): Array<{
    domain: string;
    topDomain: string;
    firstSeen: string;
    lastSeen: string;
    hitCount: number;
  }> {
    if (!this.db) {
      return [];
    }

    const stmt = this.db.prepare(`
      SELECT domain, top_domain as topDomain, first_seen as firstSeen, 
             last_seen as lastSeen, hit_count as hitCount
      FROM domains
      ORDER BY last_seen DESC
      LIMIT ? OFFSET ?
    `);

    return stmt.all(limit, offset) as Array<{
      domain: string;
      topDomain: string;
      firstSeen: string;
      lastSeen: string;
      hitCount: number;
    }>;
  }

  /**
   * Get domain count from database
   */
  getTrackedDomainCount(): number {
    if (!this.db) {
      return 0;
    }

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM domains');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Search tracked domains
   */
  searchTrackedDomains(query: string, limit: number = 100): Array<{
    domain: string;
    topDomain: string;
    hitCount: number;
  }> {
    if (!this.db) {
      return [];
    }

    const stmt = this.db.prepare(`
      SELECT domain, top_domain as topDomain, hit_count as hitCount
      FROM domains
      WHERE domain LIKE ? OR top_domain LIKE ?
      ORDER BY hit_count DESC
      LIMIT ?
    `);

    const pattern = `%${query}%`;
    return stmt.all(pattern, pattern, limit) as Array<{
      domain: string;
      topDomain: string;
      hitCount: number;
    }>;
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats & { publicDomains: number; trackedDomains: number } {
    return {
      ...this.stats,
      publicDomains: this.publicDomains.size,
      trackedDomains: this.getTrackedDomainCount(),
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      filtered: 0,
      passed: 0,
      newDomains: 0,
      existingDomains: 0,
    };
  }

  /**
   * Export public domains list
   */
  exportPublicDomains(): string[] {
    return [...this.publicDomains].sort();
  }

  /**
   * Clear database
   */
  clearDatabase(): void {
    if (this.db) {
      this.db.exec('DELETE FROM domains');
      logger.info('AntiPublic database cleared');
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.insertStmt = null;
      this.checkStmt = null;
    }
  }
}

// Singleton instance
let filterInstance: AntiPublicFilter | null = null;

/**
 * Get or create filter instance
 */
export function getAntiPublicFilter(options?: Partial<AntiPublicOptions>): AntiPublicFilter {
  if (!filterInstance) {
    filterInstance = new AntiPublicFilter(options);
  }
  return filterInstance;
}

/**
 * Reset filter instance
 */
export function resetAntiPublicFilter(): void {
  if (filterInstance) {
    filterInstance.close();
    filterInstance = null;
  }
}

/**
 * Quick filter function
 */
export function filterPublicUrls(
  urls: string[],
  options?: Partial<AntiPublicOptions>
): string[] {
  const filter = new AntiPublicFilter({ ...options, localDb: false });
  return filter.filterUrls(urls).passed;
}

export default AntiPublicFilter;
