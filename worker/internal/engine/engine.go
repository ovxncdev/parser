package engine

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// SearchEngine defines the interface for search engines
type SearchEngine interface {
	Name() string
	BuildSearchURL(query string, page int, resultsPerPage int) string
	ParseResults(html string) []SearchResult
	DetectCaptcha(html string) bool
	DetectBlock(html string) bool
}

// SearchResult represents a single search result
type SearchResult struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Position    int    `json:"position"`
}

// Google implements SearchEngine for Google
type Google struct {
	// Configuration
	Domain         string   // google.com, google.co.uk, etc.
	Language       string   // hl parameter
	Country        string   // gl parameter
	SafeSearch     bool     // safe parameter
	ExcludeDomains []string // Domains to exclude from results
}

// NewGoogle creates a new Google search engine
func NewGoogle() *Google {
	return &Google{
		Domain:     "www.google.com",
		Language:   "en",
		Country:    "us",
		SafeSearch: false,
	}
}

// Name returns the engine name
func (g *Google) Name() string {
	return "google"
}

// BuildSearchURL constructs the Google search URL
func (g *Google) BuildSearchURL(query string, page int, resultsPerPage int) string {
	// Base URL
	baseURL := fmt.Sprintf("https://%s/search", g.Domain)

	// Build query parameters
	params := url.Values{}
	params.Set("q", query)
	params.Set("hl", g.Language)
	params.Set("gl", g.Country)
	params.Set("num", fmt.Sprintf("%d", resultsPerPage))

	// Pagination (start parameter)
	if page > 0 {
		start := page * resultsPerPage
		params.Set("start", fmt.Sprintf("%d", start))
	}

	// Safe search
	if g.SafeSearch {
		params.Set("safe", "active")
	}

	// Additional params to look more legitimate
	params.Set("ie", "UTF-8")
	params.Set("oe", "UTF-8")

	return baseURL + "?" + params.Encode()
}

// ParseResults extracts URLs from Google search results HTML
func (g *Google) ParseResults(html string) []SearchResult {
	var results []SearchResult

	// Multiple patterns for extracting URLs from Google results
	patterns := []*regexp.Regexp{
		// Standard result links
		regexp.MustCompile(`<a[^>]+href="(/url\?q=|/url\?esrc=s&amp;source=web&amp;rct=j&amp;url=)([^"&]+)`),
		// Direct links in search results
		regexp.MustCompile(`<a[^>]+href="(https?://[^"]+)"[^>]*data-ved=`),
		// Cite blocks (URL display)
		regexp.MustCompile(`<cite[^>]*>([^<]+)</cite>`),
		// Data-href attributes
		regexp.MustCompile(`data-href="(https?://[^"]+)"`),
	}

	// Track seen URLs to avoid duplicates
	seen := make(map[string]bool)
	position := 0

	for _, pattern := range patterns {
		matches := pattern.FindAllStringSubmatch(html, -1)
		for _, match := range matches {
			var rawURL string
			if len(match) >= 3 {
				rawURL = match[2]
			} else if len(match) >= 2 {
				rawURL = match[1]
			} else {
				continue
			}

			// Clean and decode URL
			cleanURL := g.cleanURL(rawURL)
			if cleanURL == "" {
				continue
			}

			// Skip if already seen
			if seen[cleanURL] {
				continue
			}

			// Skip Google internal URLs
			if g.isGoogleURL(cleanURL) {
				continue
			}

			// Skip excluded domains
			if g.isExcludedDomain(cleanURL) {
				continue
			}

			seen[cleanURL] = true
			position++

			results = append(results, SearchResult{
				URL:      cleanURL,
				Position: position,
			})
		}
	}

	// Also try to extract from JSON-LD if present
	jsonResults := g.parseJSONLD(html)
	for _, jr := range jsonResults {
		if !seen[jr.URL] {
			seen[jr.URL] = true
			position++
			jr.Position = position
			results = append(results, jr)
		}
	}

	return results
}

// cleanURL decodes and cleans a URL
func (g *Google) cleanURL(rawURL string) string {
	// URL decode
	decoded, err := url.QueryUnescape(rawURL)
	if err != nil {
		decoded = rawURL
	}

	// Handle HTML entities
	decoded = strings.ReplaceAll(decoded, "&amp;", "&")
	decoded = strings.ReplaceAll(decoded, "&#39;", "'")
	decoded = strings.ReplaceAll(decoded, "&quot;", "\"")

	// Remove tracking parameters from Google redirect URLs
	if strings.Contains(decoded, "/url?") {
		if u, err := url.Parse(decoded); err == nil {
			if q := u.Query().Get("q"); q != "" {
				decoded = q
			} else if q := u.Query().Get("url"); q != "" {
				decoded = q
			}
		}
	}

	// Validate URL
	parsed, err := url.Parse(decoded)
	if err != nil {
		return ""
	}

	// Must have scheme and host
	if parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}

	// Only http/https
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}

	return decoded
}

// isGoogleURL checks if URL is a Google internal URL
func (g *Google) isGoogleURL(urlStr string) bool {
	googleDomains := []string{
		"google.com",
		"google.co",
		"googleapis.com",
		"gstatic.com",
		"googleusercontent.com",
		"google-analytics.com",
		"googleadservices.com",
		"googlesyndication.com",
		"youtube.com",
		"youtu.be",
	}

	parsed, err := url.Parse(urlStr)
	if err != nil {
		return false
	}

	host := strings.ToLower(parsed.Host)
	for _, domain := range googleDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}

	return false
}

// isExcludedDomain checks if URL matches excluded domains
func (g *Google) isExcludedDomain(urlStr string) bool {
	if len(g.ExcludeDomains) == 0 {
		return false
	}

	parsed, err := url.Parse(urlStr)
	if err != nil {
		return false
	}

	host := strings.ToLower(parsed.Host)
	for _, domain := range g.ExcludeDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}

	return false
}

// parseJSONLD attempts to extract results from JSON-LD structured data
func (g *Google) parseJSONLD(html string) []SearchResult {
	var results []SearchResult

	// Look for JSON-LD script tags
	jsonPattern := regexp.MustCompile(`<script[^>]*type="application/ld\+json"[^>]*>([^<]+)</script>`)
	matches := jsonPattern.FindAllStringSubmatch(html, -1)

	for _, match := range matches {
		if len(match) < 2 {
			continue
		}

		// Simple URL extraction from JSON (avoiding full JSON parsing)
		urlPattern := regexp.MustCompile(`"url"\s*:\s*"(https?://[^"]+)"`)
		urlMatches := urlPattern.FindAllStringSubmatch(match[1], -1)

		for _, urlMatch := range urlMatches {
			if len(urlMatch) >= 2 {
				cleanURL := g.cleanURL(urlMatch[1])
				if cleanURL != "" && !g.isGoogleURL(cleanURL) {
					results = append(results, SearchResult{
						URL: cleanURL,
					})
				}
			}
		}
	}

	return results
}

// DetectCaptcha checks if the response contains a CAPTCHA
func (g *Google) DetectCaptcha(html string) bool {
	captchaIndicators := []string{
		"captcha",
		"recaptcha",
		"g-recaptcha",
		"unusual traffic",
		"automated queries",
		"please verify",
		"not a robot",
		"verify you're human",
		"solve this puzzle",
		"/sorry/",
		"ipv4.google.com/sorry",
	}

	htmlLower := strings.ToLower(html)
	for _, indicator := range captchaIndicators {
		if strings.Contains(htmlLower, indicator) {
			return true
		}
	}

	return false
}

// DetectBlock checks if the response indicates a block/ban
func (g *Google) DetectBlock(html string) bool {
	blockIndicators := []string{
		"403 forbidden",
		"access denied",
		"blocked",
		"your ip has been",
		"temporarily blocked",
		"unusual traffic from your computer",
		"too many requests",
		"rate limit",
	}

	htmlLower := strings.ToLower(html)
	for _, indicator := range blockIndicators {
		if strings.Contains(htmlLower, indicator) {
			return true
		}
	}

	// Also check for very short responses (might be block page)
	if len(html) < 1000 && !strings.Contains(htmlLower, "<html") {
		return true
	}

	return false
}

// DetectNoResults checks if there are no search results
func (g *Google) DetectNoResults(html string) bool {
	noResultIndicators := []string{
		"did not match any documents",
		"no results found",
		"your search -",
		"did not return any results",
	}

	htmlLower := strings.ToLower(html)
	for _, indicator := range noResultIndicators {
		if strings.Contains(htmlLower, indicator) {
			return true
		}
	}

	return false
}

// GoogleDomains returns a list of Google domains for rotation
func GoogleDomains() []string {
	return []string{
		"www.google.com",
		"www.google.co.uk",
		"www.google.ca",
		"www.google.com.au",
		"www.google.de",
		"www.google.fr",
		"www.google.es",
		"www.google.it",
		"www.google.nl",
		"www.google.be",
		"www.google.ch",
		"www.google.at",
		"www.google.se",
		"www.google.no",
		"www.google.dk",
		"www.google.fi",
		"www.google.pl",
		"www.google.pt",
		"www.google.ie",
		"www.google.co.nz",
	}
}

// SetDomain sets the Google domain
func (g *Google) SetDomain(domain string) {
	g.Domain = domain
}

// SetLanguage sets the search language
func (g *Google) SetLanguage(lang string) {
	g.Language = lang
}

// SetCountry sets the search country
func (g *Google) SetCountry(country string) {
	g.Country = country
}

// AddExcludedDomain adds a domain to exclude from results
func (g *Google) AddExcludedDomain(domain string) {
	g.ExcludeDomains = append(g.ExcludeDomains, strings.ToLower(domain))
}
