package parser

import (
	"regexp"
	"strings"
)

// Extractor extracts URLs from HTML content
type Extractor struct {
	cleaner *URLCleaner
}

// ExtractionResult holds extraction results
type ExtractionResult struct {
	URLs        []string // Cleaned URLs
	RawURLs     []string // Original URLs before cleaning
	HasNextPage bool     // Whether there's a next page
	TotalResults string  // Estimated total results (if found)
}

// NewExtractor creates a new URL extractor
func NewExtractor(cleaner *URLCleaner) *Extractor {
	if cleaner == nil {
		cleaner = NewURLCleaner(DefaultCleanerConfig())
	}
	return &Extractor{
		cleaner: cleaner,
	}
}

// Google search result patterns
var (
	// Main result link patterns
	resultPatterns = []*regexp.Regexp{
		// Standard search results - href in <a> tags with data-href or direct href
		regexp.MustCompile(`<a[^>]+href="(/url\?q=|/url\?esrc=s&amp;source=web&amp;rct=j&amp;url=)([^"&]+)`),
		regexp.MustCompile(`<a[^>]+href="(https?://[^"]+)"[^>]*data-ved=`),
		regexp.MustCompile(`<a[^>]+data-href="(https?://[^"]+)"`),
		
		// Cite/URL display patterns
		regexp.MustCompile(`<cite[^>]*>([^<]+)</cite>`),
		regexp.MustCompile(`class="[^"]*iUh30[^"]*"[^>]*>([^<]+)<`),
		
		// Direct URL patterns in results
		regexp.MustCompile(`"url"\s*:\s*"(https?://[^"]+)"`),
		regexp.MustCompile(`data-url="(https?://[^"]+)"`),
		
		// Breadcrumb URLs
		regexp.MustCompile(`<span[^>]+class="[^"]*dyjrff[^"]*"[^>]*>([^<]+)</span>`),
	}

	// Patterns specifically for extracting from /url?q= format
	googleURLPattern = regexp.MustCompile(`/url\?(?:[^&]*&)*(?:q|url)=([^&"]+)`)
	
	// Direct href pattern
	directHrefPattern = regexp.MustCompile(`href="(https?://(?:[^"]+))"`)
	
	// Pattern to find all URLs in page
	allURLPattern = regexp.MustCompile(`https?://[^\s"'<>]+`)

	// Next page detection patterns
	nextPagePatterns = []*regexp.Regexp{
		regexp.MustCompile(`aria-label="Next page"`),
		regexp.MustCompile(`id="pnnext"`),
		regexp.MustCompile(`<a[^>]+class="[^"]*pn[^"]*"[^>]*>Next<`),
		regexp.MustCompile(`style="display:block"[^>]*>Next</a>`),
		regexp.MustCompile(`aria-label="Page \d+"`),
	}

	// Total results pattern
	totalResultsPattern = regexp.MustCompile(`About ([\d,]+) results`)

	// Blocked/CAPTCHA detection patterns
	captchaPatterns = []*regexp.Regexp{
		regexp.MustCompile(`<title>.*?captcha.*?</title>`),
		regexp.MustCompile(`id="captcha"`),
		regexp.MustCompile(`class="g-recaptcha"`),
		regexp.MustCompile(`www\.google\.com/recaptcha`),
		regexp.MustCompile(`unusual traffic from your computer`),
		regexp.MustCompile(`systems have detected unusual traffic`),
	}

	// Empty results patterns
	emptyResultPatterns = []*regexp.Regexp{
		regexp.MustCompile(`did not match any documents`),
		regexp.MustCompile(`No results found`),
		regexp.MustCompile(`Your search.*?did not match`),
	}

	// Domains to exclude (Google's own domains, etc.)
	excludedDomains = map[string]bool{
		"google.com":           true,
		"www.google.com":       true,
		"accounts.google.com":  true,
		"support.google.com":   true,
		"policies.google.com":  true,
		"maps.google.com":      true,
		"translate.google.com": true,
		"scholar.google.com":   true,
		"books.google.com":     true,
		"news.google.com":      true,
		"images.google.com":    true,
		"video.google.com":     true,
		"play.google.com":      true,
		"drive.google.com":     true,
		"docs.google.com":      true,
		"mail.google.com":      true,
		"calendar.google.com":  true,
		"youtube.com":          true,
		"www.youtube.com":      true,
		"youtu.be":             true,
		"gstatic.com":          true,
		"googleapis.com":       true,
		"googleusercontent.com": true,
		"googlesyndication.com": true,
		"googleadservices.com": true,
		"doubleclick.net":      true,
		"google-analytics.com": true,
		"schema.org":           true,
		"w3.org":               true,
	}
)

// ExtractFromHTML extracts URLs from Google search results HTML
func (e *Extractor) ExtractFromHTML(html string) *ExtractionResult {
	result := &ExtractionResult{
		URLs:    make([]string, 0),
		RawURLs: make([]string, 0),
	}

	// Check for empty results
	for _, pattern := range emptyResultPatterns {
		if pattern.MatchString(html) {
			return result
		}
	}

	// Extract total results if available
	if matches := totalResultsPattern.FindStringSubmatch(html); len(matches) > 1 {
		result.TotalResults = matches[1]
	}

	// Check for next page
	for _, pattern := range nextPagePatterns {
		if pattern.MatchString(html) {
			result.HasNextPage = true
			break
		}
	}

	// Collect all potential URLs
	urlCandidates := make(map[string]bool)

	// Method 1: Extract from /url?q= pattern
	googleURLMatches := googleURLPattern.FindAllStringSubmatch(html, -1)
	for _, match := range googleURLMatches {
		if len(match) > 1 {
			decoded := decodeURL(match[1])
			if decoded != "" {
				urlCandidates[decoded] = true
			}
		}
	}

	// Method 2: Extract direct hrefs
	directMatches := directHrefPattern.FindAllStringSubmatch(html, -1)
	for _, match := range directMatches {
		if len(match) > 1 {
			urlCandidates[match[1]] = true
		}
	}

	// Method 3: Try all result patterns
	for _, pattern := range resultPatterns {
		matches := pattern.FindAllStringSubmatch(html, -1)
		for _, match := range matches {
			for i := 1; i < len(match); i++ {
				if match[i] != "" {
					// Check if it's a /url?q= format
					if strings.HasPrefix(match[i], "/url?") {
						subMatches := googleURLPattern.FindStringSubmatch(match[i])
						if len(subMatches) > 1 {
							decoded := decodeURL(subMatches[1])
							if decoded != "" {
								urlCandidates[decoded] = true
							}
						}
					} else if strings.HasPrefix(match[i], "http") {
						urlCandidates[match[i]] = true
					}
				}
			}
		}
	}

	// Process and filter URLs
	seen := make(map[string]bool)
	
	for rawURL := range urlCandidates {
		// Store raw URL
		result.RawURLs = append(result.RawURLs, rawURL)

		// Clean the URL
		cleaned, err := e.cleaner.CleanAndExtract(rawURL)
		if err != nil || cleaned == "" {
			continue
		}

		// Extract domain for filtering
		domain, err := ExtractDomain(cleaned)
		if err != nil {
			continue
		}

		// Skip excluded domains
		if e.isExcludedDomain(domain) {
			continue
		}

		// Skip if not valid URL
		if !IsValidURL(cleaned) {
			continue
		}

		// Deduplicate
		normalized := NormalizeURL(cleaned)
		if seen[normalized] {
			continue
		}
		seen[normalized] = true

		result.URLs = append(result.URLs, cleaned)
	}

	return result
}

// IsCaptcha checks if the HTML indicates a CAPTCHA page
func (e *Extractor) IsCaptcha(html string) bool {
	htmlLower := strings.ToLower(html)
	for _, pattern := range captchaPatterns {
		if pattern.MatchString(htmlLower) {
			return true
		}
	}
	return false
}

// IsBlocked checks if the HTML indicates we're blocked
func (e *Extractor) IsBlocked(html string) bool {
	blockedPatterns := []string{
		"unusual traffic",
		"automated queries",
		"please show you're not a robot",
		"sorry, we could not verify",
		"blocked",
		"forbidden",
		"access denied",
	}

	htmlLower := strings.ToLower(html)
	for _, pattern := range blockedPatterns {
		if strings.Contains(htmlLower, pattern) {
			return true
		}
	}

	return false
}

// IsEmpty checks if the HTML indicates no results
func (e *Extractor) IsEmpty(html string) bool {
	for _, pattern := range emptyResultPatterns {
		if pattern.MatchString(html) {
			return true
		}
	}
	return false
}

// isExcludedDomain checks if a domain should be excluded
func (e *Extractor) isExcludedDomain(domain string) bool {
	// Direct match
	if excludedDomains[domain] {
		return true
	}

	// Check for Google domains
	if strings.HasSuffix(domain, ".google.com") ||
		strings.HasSuffix(domain, ".googleapis.com") ||
		strings.HasSuffix(domain, ".gstatic.com") ||
		strings.HasSuffix(domain, ".googleusercontent.com") {
		return true
	}

	// Check for google.TLD pattern
	if strings.HasPrefix(domain, "google.") || strings.HasPrefix(domain, "www.google.") {
		return true
	}

	return false
}

// decodeURL decodes a URL-encoded string
func decodeURL(encoded string) string {
	// Handle common encodings
	decoded := encoded

	// Replace HTML entities
	decoded = strings.ReplaceAll(decoded, "&amp;", "&")
	decoded = strings.ReplaceAll(decoded, "&lt;", "<")
	decoded = strings.ReplaceAll(decoded, "&gt;", ">")
	decoded = strings.ReplaceAll(decoded, "&quot;", "\"")
	decoded = strings.ReplaceAll(decoded, "&#39;", "'")

	// URL decode %XX sequences
	decoded = urlDecode(decoded)

	// Clean up any remaining artifacts
	decoded = strings.TrimSpace(decoded)

	// Validate it looks like a URL
	if !strings.HasPrefix(decoded, "http://") && !strings.HasPrefix(decoded, "https://") {
		return ""
	}

	return decoded
}

// urlDecode performs URL decoding
func urlDecode(s string) string {
	result := strings.Builder{}
	result.Grow(len(s))

	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if hex := s[i+1 : i+3]; isHex(hex) {
				val := hexToByte(hex)
				result.WriteByte(val)
				i += 2
				continue
			}
		}
		result.WriteByte(s[i])
	}

	return result.String()
}

// isHex checks if a string is a valid hex byte
func isHex(s string) bool {
	if len(s) != 2 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// hexToByte converts a hex string to byte
func hexToByte(s string) byte {
	var result byte
	for _, c := range s {
		result <<= 4
		switch {
		case c >= '0' && c <= '9':
			result |= byte(c - '0')
		case c >= 'a' && c <= 'f':
			result |= byte(c - 'a' + 10)
		case c >= 'A' && c <= 'F':
			result |= byte(c - 'A' + 10)
		}
	}
	return result
}

// ExtractWithParams extracts only URLs that have query parameters
func (e *Extractor) ExtractWithParams(html string) *ExtractionResult {
	fullResult := e.ExtractFromHTML(html)

	filteredURLs := make([]string, 0)
	filteredRaw := make([]string, 0)

	for i, u := range fullResult.URLs {
		if HasParameters(u) {
			filteredURLs = append(filteredURLs, u)
			if i < len(fullResult.RawURLs) {
				filteredRaw = append(filteredRaw, fullResult.RawURLs[i])
			}
		}
	}

	return &ExtractionResult{
		URLs:        filteredURLs,
		RawURLs:     filteredRaw,
		HasNextPage: fullResult.HasNextPage,
		TotalResults: fullResult.TotalResults,
	}
}

// ExtractDomains extracts unique domains from HTML
func (e *Extractor) ExtractDomains(html string) []string {
	result := e.ExtractFromHTML(html)

	domainSet := make(map[string]bool)
	domains := make([]string, 0)

	for _, u := range result.URLs {
		domain, err := ExtractDomain(u)
		if err != nil {
			continue
		}

		if !domainSet[domain] {
			domainSet[domain] = true
			domains = append(domains, domain)
		}
	}

	return domains
}

// ExtractTopDomains extracts unique top-level domains from HTML
func (e *Extractor) ExtractTopDomains(html string) []string {
	result := e.ExtractFromHTML(html)

	domainSet := make(map[string]bool)
	domains := make([]string, 0)

	for _, u := range result.URLs {
		domain, err := ExtractTopDomain(u)
		if err != nil {
			continue
		}

		if !domainSet[domain] {
			domainSet[domain] = true
			domains = append(domains, domain)
		}
	}

	return domains
}
