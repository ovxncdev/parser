/**
 * Filter Pipeline
 * Unified filtering system combining all filters
 */

import { UrlDeduplicator, DomainDeduplicator, DedupMode } from './dedup.js';
import {
  extractDomain,
  extractTopDomain,
  isValidDomain,
  matchesPattern,
} from './domain.js';
import {
  AntiPublicFilter,
  getAntiPublicFilter,
} from './antiPublic.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Filter pipeline options
export interface FilterPipelineOptions {
  // Deduplication
  removeDuplicates: boolean;
  dedupMode: DedupMode;

  // Domain filtering
  domainWhitelist: string[];
  domainBlacklist: string[];
  tldWhitelist: string[];
  tldBlacklist: string[];

  // Content filtering
  urlParamsOnly: boolean;
  minUrlLength: number;
  maxUrlLength: number;
  keywordInclude: string[];
  keywordExclude: string[];

  // Anti-public
  antiPublic: boolean;
  antiPublicOptions: {
    useDatabase: boolean;
    trackNewDomains: boolean;
  };

  // Extensions
  extensionWhitelist: string[];
  extensionBlacklist: string[];
}

const DEFAULT_OPTIONS: FilterPipelineOptions = {
  removeDuplicates: true,
  dedupMode: 'normalized',
  domainWhitelist: [],
  domainBlacklist: [],
  tldWhitelist: [],
  tldBlacklist: [],
  urlParamsOnly: false,
  minUrlLength: 10,
  maxUrlLength: 2000,
  keywordInclude: [],
  keywordExclude: [],
  antiPublic: true,
  antiPublicOptions: {
    useDatabase: true,
    trackNewDomains: true,
  },
  extensionWhitelist: [],
  extensionBlacklist: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.css', '.js', '.woff', '.woff2', '.ttf', '.eot'],
};

// Filter result
export interface FilterResult {
  url: string;
  domain: string | null;
  topDomain: string | null;
  passed: boolean;
  reasons: string[];
}

// Filtered URL with metadata
export interface FilteredUrl {
  url: string;
  domain: string;
  topDomain: string;
  hasParams: boolean;
  params: string[];
  extension: string | null;
}

// Pipeline statistics
export interface FilterStats {
  total: number;
  passed: number;
  filtered: number;
  byReason: Record<string, number>;
  uniqueDomains: number;
  uniqueTopDomains: number;
}

export class FilterPipeline {
  private options: FilterPipelineOptions;
  private urlDedup: UrlDeduplicator;
  private domainDedup: DomainDeduplicator;
  private antiPublic: AntiPublicFilter | null = null;
  private stats: FilterStats;

  constructor(options: Partial<FilterPipelineOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Initialize deduplicators
    this.urlDedup = new UrlDeduplicator(1000000, 0.01, {
      mode: this.options.dedupMode,
      normalizeUrls: true,
      removeTrackingParams: true,
      caseSensitive: false,
    });

    this.domainDedup = new DomainDeduplicator();

    // Initialize anti-public filter
    if (this.options.antiPublic) {
      this.antiPublic = getAntiPublicFilter({
        enabled: true,
        useDatabase: this.options.antiPublicOptions.useDatabase,
        trackNewDomains: this.options.antiPublicOptions.trackNewDomains,
      });
    }

    // Initialize stats
    this.stats = {
      total: 0,
      passed: 0,
      filtered: 0,
      byReason: {},
      uniqueDomains: 0,
      uniqueTopDomains: 0,
    };

    logger.debug('FilterPipeline initialized', { options: this.options });
  }

  /**
   * Filter a single URL through the pipeline
   */
  filterOne(url: string): FilterResult {
    const reasons: string[] = [];
    let passed = true;

    this.stats.total++;

    // 1. Basic validation
    if (!url || typeof url !== 'string') {
      this.addReason(reasons, 'invalid_url');
      passed = false;
    }

    // 2. Length check
    if (passed && (url.length < this.options.minUrlLength || url.length > this.options.maxUrlLength)) {
      this.addReason(reasons, 'invalid_length');
      passed = false;
    }

    // 3. Extract domain
    const domain = passed ? extractDomain(url) : null;
    const topDomain = domain ? extractTopDomain(domain) : null;

    if (passed && !domain) {
      this.addReason(reasons, 'no_domain');
      passed = false;
    }

    // 4. Domain validation
    if (passed && domain && !isValidDomain(domain)) {
      this.addReason(reasons, 'invalid_domain');
      passed = false;
    }

    // 5. TLD whitelist
    if (passed && this.options.tldWhitelist.length > 0 && topDomain) {
      const tld = topDomain.split('.').pop() || '';
      if (!this.options.tldWhitelist.includes(tld)) {
        this.addReason(reasons, 'tld_not_whitelisted');
        passed = false;
      }
    }

    // 6. TLD blacklist
    if (passed && this.options.tldBlacklist.length > 0 && topDomain) {
      const tld = topDomain.split('.').pop() || '';
      if (this.options.tldBlacklist.includes(tld)) {
        this.addReason(reasons, 'tld_blacklisted');
        passed = false;
      }
    }

    // 7. Domain whitelist
    if (passed && this.options.domainWhitelist.length > 0 && domain) {
      const matches = this.options.domainWhitelist.some(pattern =>
        matchesPattern(domain, pattern) || matchesPattern(topDomain || '', pattern)
      );
      if (!matches) {
        this.addReason(reasons, 'domain_not_whitelisted');
        passed = false;
      }
    }

    // 8. Domain blacklist
    if (passed && this.options.domainBlacklist.length > 0 && domain) {
      const matches = this.options.domainBlacklist.some(pattern =>
        matchesPattern(domain, pattern) || matchesPattern(topDomain || '', pattern)
      );
      if (matches) {
        this.addReason(reasons, 'domain_blacklisted');
        passed = false;
      }
    }

    // 9. Extension check
    if (passed) {
      const extension = this.extractExtension(url);
      if (extension) {
        if (this.options.extensionWhitelist.length > 0) {
          if (!this.options.extensionWhitelist.includes(extension)) {
            this.addReason(reasons, 'extension_not_whitelisted');
            passed = false;
          }
        }
        if (passed && this.options.extensionBlacklist.includes(extension)) {
          this.addReason(reasons, 'extension_blacklisted');
          passed = false;
        }
      }
    }

    // 10. Keyword include
    if (passed && this.options.keywordInclude.length > 0) {
      const urlLower = url.toLowerCase();
      const hasKeyword = this.options.keywordInclude.some(kw =>
        urlLower.includes(kw.toLowerCase())
      );
      if (!hasKeyword) {
        this.addReason(reasons, 'keyword_not_found');
        passed = false;
      }
    }

    // 11. Keyword exclude
    if (passed && this.options.keywordExclude.length > 0) {
      const urlLower = url.toLowerCase();
      const hasExcluded = this.options.keywordExclude.some(kw =>
        urlLower.includes(kw.toLowerCase())
      );
      if (hasExcluded) {
        this.addReason(reasons, 'keyword_excluded');
        passed = false;
      }
    }

    // 12. URL params only
    if (passed && this.options.urlParamsOnly) {
      if (!url.includes('?') || !url.includes('=')) {
        this.addReason(reasons, 'no_params');
        passed = false;
      }
    }

    // 13. Anti-public filter
    if (passed && this.antiPublic && domain) {
      if (this.antiPublic.isPublicDomain(domain)) {
        this.addReason(reasons, 'public_domain');
        passed = false;
      }
    }

    // 14. Deduplication
    if (passed && this.options.removeDuplicates) {
      if (!this.urlDedup.add(url)) {
        this.addReason(reasons, 'duplicate');
        passed = false;
      }
    }

    // Update stats
    if (passed) {
      this.stats.passed++;
      if (domain) {
        this.domainDedup.addDomain(domain);
      }
    } else {
      this.stats.filtered++;
    }

    return {
      url,
      domain,
      topDomain,
      passed,
      reasons,
    };
  }

  /**
   * Filter multiple URLs
   */
  filter(urls: string[]): FilteredUrl[] {
    const results: FilteredUrl[] = [];

    for (const url of urls) {
      const result = this.filterOne(url);

      if (result.passed && result.domain && result.topDomain) {
        results.push({
          url: result.url,
          domain: result.domain,
          topDomain: result.topDomain,
          hasParams: url.includes('?'),
          params: this.extractParams(url),
          extension: this.extractExtension(url),
        });
      }
    }

    // Update domain counts
    const counts = this.domainDedup.getCounts();
    this.stats.uniqueDomains = counts.domains;
    this.stats.uniqueTopDomains = counts.topDomains;

    return results;
  }

  /**
   * Extract file extension from URL
   */
  private extractExtension(url: string): string | null {
    try {
      const urlObj = new URL(url.includes('://') ? url : 'http://' + url);
      const pathname = urlObj.pathname;
      const lastDot = pathname.lastIndexOf('.');

      if (lastDot > 0 && lastDot < pathname.length - 1) {
        const ext = pathname.substring(lastDot).toLowerCase();
        // Only return if it looks like a file extension
        if (ext.length <= 6 && /^\.[a-z0-9]+$/.test(ext)) {
          return ext;
        }
      }
    } catch {
      // Ignore parsing errors
    }
    return null;
  }

  /**
   * Extract query parameters from URL
   */
  private extractParams(url: string): string[] {
    try {
      const urlObj = new URL(url.includes('://') ? url : 'http://' + url);
      return Array.from(urlObj.searchParams.keys());
    } catch {
      return [];
    }
  }

  /**
   * Add reason and track in stats
   */
  private addReason(reasons: string[], reason: string): void {
    reasons.push(reason);
    this.stats.byReason[reason] = (this.stats.byReason[reason] || 0) + 1;
  }

  /**
   * Get statistics
   */
  getStats(): FilterStats {
    const counts = this.domainDedup.getCounts();
    return {
      ...this.stats,
      uniqueDomains: counts.domains,
      uniqueTopDomains: counts.topDomains,
    };
  }

  /**
   * Get unique domains
   */
  getUniqueDomains(): string[] {
    return this.domainDedup.getDomains();
  }

  /**
   * Get unique top domains
   */
  getUniqueTopDomains(): string[] {
    return this.domainDedup.getTopDomains();
  }

  /**
   * Reset all filters and stats
   */
  reset(): void {
    this.urlDedup.clear();
    this.domainDedup.clear();
    if (this.antiPublic) {
      this.antiPublic.resetStats();
    }
    this.stats = {
      total: 0,
      passed: 0,
      filtered: 0,
      byReason: {},
      uniqueDomains: 0,
      uniqueTopDomains: 0,
    };
  }

  /**
   * Export state for persistence
   */
  exportState(): object {
    return {
      stats: this.stats,
      urlDedupState: this.urlDedup.exportState(),
      domainDedupState: this.domainDedup.exportState(),
    };
  }

  /**
   * Import state from persistence
   */
  importState(state: any): void {
    if (state.stats) {
      this.stats = state.stats;
    }
    if (state.urlDedupState) {
      this.urlDedup.importState(state.urlDedupState);
    }
    if (state.domainDedupState) {
      this.domainDedup.importState(state.domainDedupState);
    }
  }
}

// Singleton instance
let filterPipelineInstance: FilterPipeline | null = null;

export function getFilterPipeline(options?: Partial<FilterPipelineOptions>): FilterPipeline {
  if (!filterPipelineInstance) {
    filterPipelineInstance = new FilterPipeline(options);
  }
  return filterPipelineInstance;
}

export function resetFilterPipeline(): void {
  if (filterPipelineInstance) {
    filterPipelineInstance.reset();
    filterPipelineInstance = null;
  }
}

// Re-export sub-modules
export * from './domain.js';
export * from './dedup.js';
export { AntiPublicFilter, getAntiPublicFilter } from './antiPublic.js';

export default FilterPipeline;
