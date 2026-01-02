/**
 * URL Deduplication
 * Bloom filter and exact set for memory-efficient deduplication
 */

import { BloomFilter } from 'bloom-filters';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Deduplication modes
export type DedupMode = 'exact' | 'normalized' | 'domain' | 'topDomain';

export interface DedupOptions {
  mode: DedupMode;
  normalizeUrls: boolean;
  removeTrackingParams: boolean;
  caseSensitive: boolean;
}

const DEFAULT_OPTIONS: DedupOptions = {
  mode: 'normalized',
  normalizeUrls: true,
  removeTrackingParams: true,
  caseSensitive: false,
};

// Common tracking parameters to remove
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'zanpid', 'msclkid',
  '_ga', '_gl', '_hsenc', '_hsmi', 'mc_cid', 'mc_eid',
  'ref', 'referer', 'referrer', 'source', 'src',
  'affiliate', 'aff_id', 'partner', 'campaign',
  'track', 'tracking', 'trk', 'click_id',
];

export class UrlDeduplicator {
  private bloomFilter: BloomFilter;
  private exactSet: Set<string> | null;
  private options: DedupOptions;
  private count: number = 0;

  constructor(
    expectedItems: number = 1000000,
    errorRate: number = 0.01,
    options: Partial<DedupOptions> = {},
    useExactFallback: boolean = false
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Create bloom filter
    this.bloomFilter = BloomFilter.create(expectedItems, errorRate);

    // Optionally use exact set for smaller datasets or when accuracy is critical
    this.exactSet = useExactFallback ? new Set<string>() : null;

    logger.debug('Deduplicator initialized', {
      expectedItems,
      errorRate,
      mode: this.options.mode,
      useExactFallback,
    });
  }

  /**
   * Normalize a URL for deduplication
   */
  normalizeUrl(url: string): string {
    try {
      let urlToParse = url;
      if (!url.includes('://')) {
        urlToParse = 'http://' + url;
      }

      const parsed = new URL(urlToParse);

      // Lowercase hostname
      let normalized = parsed.protocol + '//' + parsed.hostname.toLowerCase();

      // Add port if non-standard
      if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
        normalized += ':' + parsed.port;
      }

      // Normalize path (remove trailing slash except for root)
      let pathname = parsed.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      normalized += pathname;

      // Handle query parameters
      if (parsed.search) {
        const params = new URLSearchParams(parsed.search);

        // Remove tracking parameters
        if (this.options.removeTrackingParams) {
          for (const param of TRACKING_PARAMS) {
            params.delete(param);
          }
        }

        // Sort parameters for consistency
        const sortedParams = new URLSearchParams();
        const keys = Array.from(params.keys()).sort();
        for (const key of keys) {
          const value = params.get(key);
          if (value !== null) {
            sortedParams.set(key, value);
          }
        }

        const queryString = sortedParams.toString();
        if (queryString) {
          normalized += '?' + queryString;
        }
      }

      // Remove fragment/hash
      // (already excluded by not adding parsed.hash)

      return this.options.caseSensitive ? normalized : normalized.toLowerCase();
    } catch {
      // If parsing fails, return original URL (possibly lowercased)
      return this.options.caseSensitive ? url : url.toLowerCase();
    }
  }

  /**
   * Extract domain from URL
   */
  extractDomain(url: string): string {
    try {
      let urlToParse = url;
      if (!url.includes('://')) {
        urlToParse = 'http://' + url;
      }
      const parsed = new URL(urlToParse);
      return parsed.hostname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  /**
   * Extract top-level domain from URL
   */
  extractTopDomain(url: string): string {
    const domain = this.extractDomain(url);
    const parts = domain.split('.');

    if (parts.length <= 2) return domain;

    // Handle common second-level TLDs
    const secondLevelTlds = [
      'co.uk', 'com.au', 'com.br', 'co.jp', 'co.kr', 'co.nz', 'co.za',
      'com.cn', 'com.mx', 'com.tw', 'org.uk', 'net.au',
    ];

    const lastTwo = parts.slice(-2).join('.');
    for (const stld of secondLevelTlds) {
      if (lastTwo === stld) {
        return parts.slice(-3).join('.');
      }
    }

    return lastTwo;
  }

  /**
   * Get the key for deduplication based on mode
   */
  private getKey(url: string): string {
    switch (this.options.mode) {
      case 'exact':
        return this.options.caseSensitive ? url : url.toLowerCase();
      case 'normalized':
        return this.normalizeUrl(url);
      case 'domain':
        return this.extractDomain(url);
      case 'topDomain':
        return this.extractTopDomain(url);
      default:
        return this.normalizeUrl(url);
    }
  }

  /**
   * Check if URL has been seen (might have false positives with bloom filter)
   */
  has(url: string): boolean {
    const key = this.getKey(url);

    // Check exact set first if available
    if (this.exactSet) {
      return this.exactSet.has(key);
    }

    return this.bloomFilter.has(key);
  }

  /**
   * Add URL to the deduplicator
   * Returns true if it was new, false if already seen
   */
  add(url: string): boolean {
    const key = this.getKey(url);

    // Check if already exists
    if (this.exactSet) {
      if (this.exactSet.has(key)) {
        return false;
      }
      this.exactSet.add(key);
      this.bloomFilter.add(key);
      this.count++;
      return true;
    }

    // Bloom filter only - may have false positives
    if (this.bloomFilter.has(key)) {
      return false; // Probably seen before
    }

    this.bloomFilter.add(key);
    this.count++;
    return true;
  }

  /**
   * Add URL only if not seen, return whether it was added
   */
  addIfNew(url: string): { added: boolean; key: string } {
    const key = this.getKey(url);
    const added = this.add(url);
    return { added, key };
  }

  /**
   * Filter array of URLs, returning only unique ones
   */
  filterUnique(urls: string[]): string[] {
    const unique: string[] = [];

    for (const url of urls) {
      if (this.add(url)) {
        unique.push(url);
      }
    }

    return unique;
  }

  /**
   * Get count of unique items
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Clear the deduplicator
   */
  clear(): void {
    // Create a new bloom filter with same parameters
    this.bloomFilter = BloomFilter.create(1000000, 0.01);
    if (this.exactSet) {
      this.exactSet.clear();
    }
    this.count = 0;
  }

  /**
   * Export state for persistence
   */
  exportState(): { count: number; exactSet?: string[] } {
    const state: { count: number; exactSet?: string[] } = {
      count: this.count,
    };

    if (this.exactSet) {
      state.exactSet = Array.from(this.exactSet);
    }

    return state;
  }

  /**
   * Import state from persistence
   */
  importState(state: { count: number; exactSet?: string[] }): void {
    this.count = state.count;

    if (state.exactSet && this.exactSet) {
      for (const key of state.exactSet) {
        this.exactSet.add(key);
        this.bloomFilter.add(key);
      }
    }
  }
}

/**
 * Domain-level deduplicator
 */
export class DomainDeduplicator {
  private domains: Set<string> = new Set();
  private topDomains: Set<string> = new Set();

  /**
   * Extract domain from URL
   */
  extractDomain(url: string): string {
    try {
      let urlToParse = url;
      if (!url.includes('://')) {
        urlToParse = 'http://' + url;
      }
      const parsed = new URL(urlToParse);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * Extract top domain
   */
  extractTopDomain(domain: string): string {
    const parts = domain.split('.');
    if (parts.length <= 2) return domain;

    const secondLevelTlds = ['co.uk', 'com.au', 'com.br', 'co.jp', 'co.kr'];
    const lastTwo = parts.slice(-2).join('.');

    for (const stld of secondLevelTlds) {
      if (lastTwo === stld) {
        return parts.slice(-3).join('.');
      }
    }

    return lastTwo;
  }

  /**
   * Add domain
   */
  addDomain(domain: string): boolean {
    const lower = domain.toLowerCase();
    if (this.domains.has(lower)) {
      return false;
    }
    this.domains.add(lower);

    const topDomain = this.extractTopDomain(lower);
    this.topDomains.add(topDomain);

    return true;
  }

  /**
   * Add domain from URL
   */
  addFromUrl(url: string): boolean {
    const domain = this.extractDomain(url);
    if (!domain) return false;
    return this.addDomain(domain);
  }

  /**
   * Check if domain exists
   */
  hasDomain(domain: string): boolean {
    return this.domains.has(domain.toLowerCase());
  }

  /**
   * Check if top domain exists
   */
  hasTopDomain(domain: string): boolean {
    const topDomain = this.extractTopDomain(domain.toLowerCase());
    return this.topDomains.has(topDomain);
  }

  /**
   * Get all domains
   */
  getDomains(): string[] {
    return Array.from(this.domains);
  }

  /**
   * Get all top domains
   */
  getTopDomains(): string[] {
    return Array.from(this.topDomains);
  }

  /**
   * Get counts
   */
  getCounts(): { domains: number; topDomains: number } {
    return {
      domains: this.domains.size,
      topDomains: this.topDomains.size,
    };
  }

  /**
   * Clear
   */
  clear(): void {
    this.domains.clear();
    this.topDomains.clear();
  }

  /**
   * Export state
   */
  exportState(): { domains: string[]; topDomains: string[] } {
    return {
      domains: Array.from(this.domains),
      topDomains: Array.from(this.topDomains),
    };
  }

  /**
   * Import state
   */
  importState(state: { domains: string[]; topDomains: string[] }): void {
    for (const d of state.domains) {
      this.domains.add(d);
    }
    for (const td of state.topDomains) {
      this.topDomains.add(td);
    }
  }
}

// Helper functions
export function deduplicateUrls(urls: string[], mode: DedupMode = 'normalized'): string[] {
  const dedup = new UrlDeduplicator(urls.length, 0.01, { mode }, true);
  return dedup.filterUnique(urls);
}

export function deduplicateByDomain(urls: string[]): { url: string; domain: string }[] {
  const seen = new Set<string>();
  const result: { url: string; domain: string }[] = [];

  for (const url of urls) {
    try {
      let urlToParse = url;
      if (!url.includes('://')) {
        urlToParse = 'http://' + url;
      }
      const parsed = new URL(urlToParse);
      const domain = parsed.hostname.toLowerCase();

      if (!seen.has(domain)) {
        seen.add(domain);
        result.push({ url, domain });
      }
    } catch {
      // Skip invalid URLs
    }
  }

  return result;
}

export function deduplicateByTopDomain(urls: string[]): { url: string; topDomain: string }[] {
  const dedup = new DomainDeduplicator();
  const result: { url: string; topDomain: string }[] = [];

  for (const url of urls) {
    const domain = dedup.extractDomain(url);
    if (!domain) continue;

    const topDomain = dedup.extractTopDomain(domain);
    if (!dedup.hasTopDomain(domain)) {
      dedup.addDomain(domain);
      result.push({ url, topDomain });
    }
  }

  return result;
}

export default UrlDeduplicator;
