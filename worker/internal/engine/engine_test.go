package engine

import (
	"strings"
	"testing"
)

func TestNewGoogle(t *testing.T) {
	g := NewGoogle()

	if g == nil {
		t.Fatal("NewGoogle returned nil")
	}

	if g.Domain != "www.google.com" {
		t.Errorf("default domain = %q, want %q", g.Domain, "www.google.com")
	}

	if g.Language != "en" {
		t.Errorf("default language = %q, want %q", g.Language, "en")
	}

	if g.Country != "us" {
		t.Errorf("default country = %q, want %q", g.Country, "us")
	}
}

func TestGoogleName(t *testing.T) {
	g := NewGoogle()

	if g.Name() != "google" {
		t.Errorf("Name() = %q, want %q", g.Name(), "google")
	}
}

func TestGoogleBuildSearchURL(t *testing.T) {
	g := NewGoogle()

	tests := []struct {
		name           string
		query          string
		page           int
		resultsPerPage int
		wantContains   []string
		wantNotContain []string
	}{
		{
			name:           "basic query",
			query:          "inurl:admin",
			page:           0,
			resultsPerPage: 10,
			wantContains:   []string{"google.com/search", "q=inurl%3Aadmin", "num=10"},
			wantNotContain: []string{"start="},
		},
		{
			name:           "page 2",
			query:          "test query",
			page:           1,
			resultsPerPage: 10,
			wantContains:   []string{"start=10"},
		},
		{
			name:           "page 3 with 20 results",
			query:          "test",
			page:           2,
			resultsPerPage: 20,
			wantContains:   []string{"start=40", "num=20"},
		},
		{
			name:           "special characters",
			query:          `filetype:pdf "confidential"`,
			page:           0,
			resultsPerPage: 10,
			wantContains:   []string{"filetype%3Apdf"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			url := g.BuildSearchURL(tt.query, tt.page, tt.resultsPerPage)

			for _, want := range tt.wantContains {
				if !strings.Contains(url, want) {
					t.Errorf("URL should contain %q, got: %s", want, url)
				}
			}

			for _, notWant := range tt.wantNotContain {
				if strings.Contains(url, notWant) {
					t.Errorf("URL should not contain %q, got: %s", notWant, url)
				}
			}
		})
	}
}

func TestGoogleBuildSearchURLWithSafeSearch(t *testing.T) {
	g := NewGoogle()
	g.SafeSearch = true

	url := g.BuildSearchURL("test", 0, 10)

	if !strings.Contains(url, "safe=active") {
		t.Errorf("URL should contain safe=active when SafeSearch is enabled, got: %s", url)
	}
}

func TestGoogleBuildSearchURLWithDifferentDomain(t *testing.T) {
	g := NewGoogle()
	g.SetDomain("www.google.co.uk")

	url := g.BuildSearchURL("test", 0, 10)

	if !strings.Contains(url, "google.co.uk") {
		t.Errorf("URL should use custom domain, got: %s", url)
	}
}

func TestGoogleParseResults(t *testing.T) {
	g := NewGoogle()

	// Simulated Google search results HTML
	html := `
	<html>
	<body>
		<div class="g">
			<a href="/url?q=https://example.com/admin&amp;sa=U">Example Admin</a>
		</div>
		<div class="g">
			<a href="/url?q=https://test.org/login&amp;sa=U">Test Login</a>
		</div>
		<div class="g">
			<a href="https://another-site.com/page" data-ved="123">Another Site</a>
		</div>
		<div class="g">
			<a href="/url?q=https://google.com/something">Google Internal</a>
		</div>
		<div class="g">
			<a href="/url?q=https://duplicate.com/page">Duplicate</a>
		</div>
		<div class="g">
			<a href="/url?q=https://duplicate.com/page">Duplicate Again</a>
		</div>
	</body>
	</html>
	`

	results := g.ParseResults(html)

	// Should find at least the non-Google URLs
	if len(results) < 3 {
		t.Errorf("expected at least 3 results, got %d", len(results))
	}

	// Check for expected URLs
	foundExample := false
	foundTest := false
	foundGoogle := false
	duplicateCount := 0

	for _, r := range results {
		if strings.Contains(r.URL, "example.com") {
			foundExample = true
		}
		if strings.Contains(r.URL, "test.org") {
			foundTest = true
		}
		if strings.Contains(r.URL, "google.com") {
			foundGoogle = true
		}
		if strings.Contains(r.URL, "duplicate.com") {
			duplicateCount++
		}
	}

	if !foundExample {
		t.Error("should find example.com URL")
	}

	if !foundTest {
		t.Error("should find test.org URL")
	}

	if foundGoogle {
		t.Error("should filter out google.com URLs")
	}

	if duplicateCount > 1 {
		t.Errorf("should deduplicate URLs, found %d duplicates", duplicateCount)
	}
}

func TestGoogleParseResultsWithJSONLD(t *testing.T) {
	g := NewGoogle()

	html := `
	<html>
	<head>
		<script type="application/ld+json">
		{
			"@type": "SearchResultsPage",
			"mainEntity": {
				"@type": "ItemList",
				"itemListElement": [
					{"url": "https://jsonld-result.com/page1"},
					{"url": "https://jsonld-result.com/page2"}
				]
			}
		}
		</script>
	</head>
	<body>
		<div class="g">
			<a href="/url?q=https://regular-result.com">Regular</a>
		</div>
	</body>
	</html>
	`

	results := g.ParseResults(html)

	foundJSONLD := false
	for _, r := range results {
		if strings.Contains(r.URL, "jsonld-result.com") {
			foundJSONLD = true
			break
		}
	}

	if !foundJSONLD {
		t.Error("should extract URLs from JSON-LD")
	}
}

func TestGoogleCleanURL(t *testing.T) {
	g := NewGoogle()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "already clean",
			input: "https://example.com/page",
			want:  "https://example.com/page",
		},
		{
			name:  "url encoded",
			input: "https%3A%2F%2Fexample.com%2Fpage",
			want:  "https://example.com/page",
		},
		{
			name:  "html entities",
			input: "https://example.com/page?a=1&amp;b=2",
			want:  "https://example.com/page?a=1&b=2",
		},
		{
			name:  "google redirect",
			input: "/url?q=https://example.com/page&sa=U",
			want:  "https://example.com/page",
		},
		{
			name:  "no scheme",
			input: "example.com/page",
			want:  "",
		},
		{
			name:  "invalid scheme",
			input: "javascript:alert(1)",
			want:  "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := g.cleanURL(tt.input)
			if got != tt.want {
				t.Errorf("cleanURL(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestGoogleIsGoogleURL(t *testing.T) {
	g := NewGoogle()

	tests := []struct {
		url  string
		want bool
	}{
		{"https://www.google.com/search", true},
		{"https://google.com/page", true},
		{"https://maps.google.com/", true},
		{"https://youtube.com/watch", true},
		{"https://googleapis.com/api", true},
		{"https://example.com/page", false},
		{"https://notgoogle.com/", false},
		{"https://mygoogle.com/", false},
	}

	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			got := g.isGoogleURL(tt.url)
			if got != tt.want {
				t.Errorf("isGoogleURL(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}

func TestGoogleIsExcludedDomain(t *testing.T) {
	g := NewGoogle()
	g.AddExcludedDomain("facebook.com")
	g.AddExcludedDomain("twitter.com")

	tests := []struct {
		url  string
		want bool
	}{
		{"https://facebook.com/page", true},
		{"https://www.facebook.com/page", true},
		{"https://m.facebook.com/page", true},
		{"https://twitter.com/user", true},
		{"https://example.com/page", false},
		{"https://notfacebook.com/", false},
	}

	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			got := g.isExcludedDomain(tt.url)
			if got != tt.want {
				t.Errorf("isExcludedDomain(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}

func TestGoogleDetectCaptcha(t *testing.T) {
	g := NewGoogle()

	tests := []struct {
		name string
		html string
		want bool
	}{
		{
			name: "recaptcha present",
			html: `<html><body><div class="g-recaptcha"></div></body></html>`,
			want: true,
		},
		{
			name: "unusual traffic message",
			html: `<html><body>Our systems have detected unusual traffic from your computer</body></html>`,
			want: true,
		},
		{
			name: "sorry page",
			html: `<html><body>https://ipv4.google.com/sorry/index</body></html>`,
			want: true,
		},
		{
			name: "normal results",
			html: `<html><body><div class="g"><a href="https://example.com">Result</a></div></body></html>`,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := g.DetectCaptcha(tt.html)
			if got != tt.want {
				t.Errorf("DetectCaptcha() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGoogleDetectBlock(t *testing.T) {
	g := NewGoogle()

	tests := []struct {
		name string
		html string
		want bool
	}{
		{
			name: "403 forbidden",
			html: `<html><body>403 Forbidden</body></html>`,
			want: true,
		},
		{
			name: "access denied",
			html: `<html><body>Access Denied - Your IP has been blocked</body></html>`,
			want: true,
		},
		{
			name: "too many requests",
			html: `<html><body>Too many requests from your IP</body></html>`,
			want: true,
		},
		{
			name: "very short response",
			html: `blocked`,
			want: true,
		},
		{
			name: "normal results",
			html: `<html><body><div class="g"><a href="https://example.com">Result</a></div></body></html>`,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := g.DetectBlock(tt.html)
			if got != tt.want {
				t.Errorf("DetectBlock() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGoogleDetectNoResults(t *testing.T) {
	g := NewGoogle()

	tests := []struct {
		name string
		html string
		want bool
	}{
		{
			name: "no results message",
			html: `<html><body>Your search did not match any documents</body></html>`,
			want: true,
		},
		{
			name: "no results found",
			html: `<html><body>No results found for your query</body></html>`,
			want: true,
		},
		{
			name: "normal results",
			html: `<html><body><div class="g"><a href="https://example.com">Result</a></div></body></html>`,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := g.DetectNoResults(tt.html)
			if got != tt.want {
				t.Errorf("DetectNoResults() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGoogleDomains(t *testing.T) {
	domains := GoogleDomains()

	if len(domains) < 10 {
		t.Errorf("expected at least 10 Google domains, got %d", len(domains))
	}

	// Check that www.google.com is in the list
	found := false
	for _, d := range domains {
		if d == "www.google.com" {
			found = true
			break
		}
	}

	if !found {
		t.Error("www.google.com should be in the domains list")
	}

	// All domains should start with www.google
	for _, d := range domains {
		if !strings.HasPrefix(d, "www.google") {
			t.Errorf("domain %q should start with www.google", d)
		}
	}
}

func TestGoogleSetters(t *testing.T) {
	g := NewGoogle()

	g.SetDomain("www.google.de")
	if g.Domain != "www.google.de" {
		t.Errorf("SetDomain failed, got %q", g.Domain)
	}

	g.SetLanguage("de")
	if g.Language != "de" {
		t.Errorf("SetLanguage failed, got %q", g.Language)
	}

	g.SetCountry("de")
	if g.Country != "de" {
		t.Errorf("SetCountry failed, got %q", g.Country)
	}
}

func TestGoogleResultPositions(t *testing.T) {
	g := NewGoogle()

	html := `
	<html>
	<body>
		<div class="g">
			<a href="/url?q=https://first.com">First</a>
		</div>
		<div class="g">
			<a href="/url?q=https://second.com">Second</a>
		</div>
		<div class="g">
			<a href="/url?q=https://third.com">Third</a>
		</div>
	</body>
	</html>
	`

	results := g.ParseResults(html)

	if len(results) < 3 {
		t.Fatalf("expected at least 3 results, got %d", len(results))
	}

	// Positions should be sequential
	for i, r := range results {
		expectedPos := i + 1
		if r.Position != expectedPos {
			t.Errorf("result %d position = %d, want %d", i, r.Position, expectedPos)
		}
	}
}
