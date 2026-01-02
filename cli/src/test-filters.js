import { FilterPipeline } from './filters.js';

const filter = new FilterPipeline({
  antiPublic: true,
  dedup: true,
  domainDedup: true
});

const testUrls = [
  'https://example.com/admin',
  'https://example.com/login',          // Same domain - should be filtered
  'https://google.com/search',          // Anti-public - should be filtered
  'https://facebook.com/page',          // Anti-public - should be filtered
  'https://target1.com/page?id=1',
  'https://target2.com/admin',
  'https://target1.com/other',          // Same domain - should be filtered
  'https://www.google.com/url?q=https://realsite.com/page',  // Redirect - should extract
  'https://target3.com/page',
];

console.log('Testing Filter Pipeline\n');
console.log('Input URLs:');
testUrls.forEach(u => console.log('  ' + u));

console.log('\nFiltered URLs:');
const results = filter.filter(testUrls);
results.forEach(u => console.log('  ✓ ' + u));

console.log('\nStats:');
const stats = filter.getStats();
console.log(`  Input: ${stats.input}`);
console.log(`  After redirect clean: ${stats.afterRedirect}`);
console.log(`  After dedup: ${stats.afterDedup}`);
console.log(`  After anti-public: ${stats.afterAntiPublic}`);
console.log(`  After domain dedup: ${stats.afterDomainDedup}`);
console.log(`  Output: ${stats.output}`);
console.log(`  Unique domains: ${stats.uniqueDomains}`);
