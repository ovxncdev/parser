/**
 * Deduplication Utility
 * High-performance URL deduplication using Bloom filters and exact matching
 */

import { BloomFilter } from 'bloom-filters';
import { extractDomain, extractTopDomain, normalizeDomain } from './domain.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger();

// Dedup modes
export type DedupMode = 'exact' | 'normalized' | 'domain' | 'topDomain';

// Dedup options
export interface DedupOptions {
  mode: DedupMode;
  caseSensitive: boolean;
  removeWww: boolean;
  removeTrailingSlash: boolean;
  removeFragment: boolean;
  sortParams: boolean;
  removeTrackingParams: boolean;
}

const DEFAULT_OPTIONS: DedupOptions = {
  mode: 'normalized',
  caseSensitive: false,
  removeWww: true,
  removeTrailingSlash: true,
  removeFragment: true,
  sortParams: true,
  removeTrackingParams: true,
};

// Common tracking parameters to remove
const TRACKING_PARAMS = new Set([
  // Google
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gclsrc', 'dclid',
  // Facebook
  'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
  // Microsoft
  'msclkid',
  // Others
  'mc_cid', 'mc_eid', '_ga', '_gl', '_hsenc', '_hsmi',
  'mkt_tok', 'oly_enc_id', 'oly_anon_id', 'vero_id',
  '_openstat', 'yclid', 'wickedid',
  'ref', 'referrer', 'source', 'src',
  // Analytics
  'ref_', 'ref_src', 'ref_url',
]);

/**
 * URL Deduplicator using Bloom Filter for memory efficiency
 */
export class UrlDeduplicator {
  private bloomFilter: BloomFilter;
  private exactSet: Set<string> | null;
  private options: DedupOptions;
  private count: number = 0;
  private useExactFallback: boolean;

  constructor(
    expectedItems: number = 1000000,
    errorRate: number = 0.01,
    options: Partial<DedupOptions> = {},
    useExactFallback: boolean = false
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.useExactFallback = useExactFallback;

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
   * Normalize URL based on options
   */
  normalizeUrl(url: string): string {
    try {
      let normalized = url.trim();

      // Add protocol if missing
      if (!normalized.includes('://')) {
        normalized = 'https://' + normalized;
      }

      const parsed = new URL(normalized);

      // Lowercase host
      if (!this.options.caseSensitive) {
        parsed.hostname = parsed.hostname.toLowerCase();
      }

      // Remove www
      if (this.options.removeWww && parsed.hostname.startsWith('www.')) {
        parsed.hostname = parsed.hostname.substring(4);
      }

      // Remove fragment
      if (this.options.removeFragment) {
        parsed.hash = '';
      }

      // Process query parameters
      if (parsed.search) {
        const params = new URLSearchParams(parsed.search);
        const newParams = new URLSearchParams();

        // Sort and filter params
        const keys = [...params.keys()];
        if (this.options.sortParams) {
          keys.sort();
        }

        for (const key of keys) {
          // Skip tracking params
          if (this.options.removeTrackingParams && TRACKING_PARAMS.has(key.toLowerCase())) {
            continue;
          }

          const value = params.get(key);
          if (value !== null && value !== '') {
            newParams.set(key, value);
          }
        }

        parsed.search = newParams.toString();
      }

      // Build URL
      let result = parsed.toString();

      // Remove trailing slash (except for root)
      if (this.options.removeTrailingSlash && result.endsWith('/') && parsed.pathname !== '/') {
        result = result.slice(0, -1);
      }

      return result;
    } catch {
      // If URL parsing fails, return trimmed original
      return url.trim().toLowerCase();
    }
  }

  /**
   * Get key for deduplication based on mode
   */
  private getKey(url: string): string {
    switch (this.options.mode) {
      case 'exact':
        return this.options.caseSensitive ? url : url.toLowerCase();

      case 'normalized':
        return this.normalizeUrl(url);

      case 'domain':
        const domain = extractDomain(url);
        return domain ? normalizeDomain(domain, this.options.removeWww) : url;

      case 'topDomain':
        const topDomain = extractTopDomain(url);
        return topDomain ? normalizeDomain(topDomain, this.options.removeWww) : url;

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
   */
  add(url: string): boolean {
    const key = this.getKey(url);

    // Check if already exists
    if (this.has(url)) {
      return false;
    }

    // Add to bloom filter
    this.bloomFilter.add(key);

    // Add to exact set if available
    if (this.exactSet) {
      this.exactSet.add(key);
    }

    this.count++;
    return true;
  }

  /**
   * Add multiple URLs, return those that were new
   */
  addMany(urls: string[]): string[] {
    const newUrls: string[] = [];

    for (const url of urls) {
      if (this.add(url)) {
        newUrls.push(url);
      }
    }

    return newUrls;
  }

  /**
   * Filter URLs, keeping only unique ones
   */
  filter(urls: string[]): string[] {
    return urls.filter(url => this.add(url));
  }

  /**
   * Check and add in one operation
   */
  checkAndAdd(url: string): { isNew: boolean; key: string } {
    const key = this.getKey(url);
    const isNew = !this.has(url);

    if (isNew) {
      this.bloomFilter.add(key);
      if (this.exactSet) {
        this.exactSet.add(key);
      }
      this.count++;
    }

    return { isNew, key };
  }

  /**
   * Get count of added items
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Get estimated false positive rate
   */
  getFalsePositiveRate(): number {
    return this.bloomFilter.rate();
  }

  /**
   * Clear the deduplicator
   */
  clear(): void {
    this.bloomFilter = BloomFilter.create(
      this.bloomFilter.size,
      this.bloomFilter.nbHashes
    );
    if (this.exactSet) {
      this.exactSet.clear();
    }
    this.count = 0;
  }

  /**
   * Export state for persistence
   */
  export(): { filter: object; exactSet?: string[]; count: number } {
    return {
      filter: this.bloomFilter.saveAsJSON(),
      exactSet: this.exactSet ? [...this.exactSet] : undefined,
      count: this.count,
    };
  }

  /**
   * Import state
   */
  import(state: { filter: object; exactSet?: string[]; count: number }): void {
    this.bloomFilter = BloomFilter.fromJSON(state.filter as any);
    if (state.exactSet && this.exactSet) {
      this.exactSet = new Set(state.exactSet);
    }
    this.count = state.count;
  }
}

/**
 * Domain Deduplicator - specifically for domain-level deduplication
 */
export class DomainDeduplicator {
  private domains: Set<string>;
  private topDomains: Set<string>;
  private removeWww: boolean;

  constructor(removeWww: boolean = true) {
    this.domains = new Set();
    this.topDomains = new Set();
    this.removeWww = removeWww;
  }

  /**
   * Add a domain
   */
  addDomain(domain: string): boolean {
    const normalized = normalizeDomain(domain, this.removeWww);
    
    if (this.domains.has(normalized)) {
      return false;
    }

    this.domains.add(normalized);
    return true;
  }

  /**
   * Add a top domain
   */
  addTopDomain(domain: string): boolean {
    const topDomain = extractTopDomain('http://' + domain) || domain;
    const normalized = normalizeDomain(topDomain, this.removeWww);

    if (this.topDomains.has(normalized)) {
      return false;
    }

    this.topDomains.add(normalized);
    return true;
  }

  /**
   * Add domain from URL
   */
  addFromUrl(url: string): { domain: string | null; isNewDomain: boolean; isNewTopDomain: boolean } {
    const domain = extractDomain(url);
    const topDomain = extractTopDomain(url);

    if (!domain) {
      return { domain: null, isNewDomain: false, isNewTopDomain: false };
    }

    return {
      domain,
      isNewDomain: this.addDomain(domain),
      isNewTopDomain: topDomain ? this.addTopDomain(topDomain) : false,
    };
  }

  /**
   * Check if domain exists
   */
  hasDomain(domain: string): boolean {
    return this.domains.has(normalizeDomain(domain, this.removeWww));
  }

  /**
   * Check if top domain exists
   */
  hasTopDomain(domain: string): boolean {
    const topDomain = extractTopDomain('http://' + domain) || domain;
    return this.topDomains.has(normalizeDomain(topDomain, this.removeWww));
  }

  /**
   * Get all domains
   */
  getDomains(): string[] {
    return [...this.domains];
  }

  /**
   * Get all top domains
   */
  getTopDomains(): string[] {
    return [...this.topDomains];
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
}

/**
 * Simple deduplication for small datasets
 */
export function deduplicateUrls(
  urls: string[],
  options: Partial<DedupOptions> = {}
): string[] {
  const dedup = new UrlDeduplicator(urls.length * 2, 0.001, options, true);
  return dedup.filter(urls);
}

/**
 * Deduplicate by domain
 */
export function deduplicateByDomain(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const url of urls) {
    const domain = extractDomain(url);
    if (!domain) continue;

    const normalized = normalizeDomain(domain);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(url);
    }
  }

  return result;
}

/**
 * Deduplicate by top domain
 */
export function deduplicateByTopDomain(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const url of urls) {
    const topDomain = extractTopDomain(url);
    if (!topDomain) continue;

    const normalized = normalizeDomain(topDomain);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(url);
    }
  }

  return result;
}

export default {
  UrlDeduplicator,
  DomainDeduplicator,
  deduplicateUrls,
  deduplicateByDomain,
  deduplicateByTopDomain,
};
