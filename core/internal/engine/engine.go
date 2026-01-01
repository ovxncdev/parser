package engine

import (
	"context"
	"time"

	"github.com/google-dork-parser/core/internal/parser"
	"github.com/google-dork-parser/core/internal/proxy"
)

// Engine defines the interface for search engines
type Engine interface {
	// Name returns the engine name
	Name() string

	// Search performs a search with the given dork
	Search(ctx context.Context, request *SearchRequest) (*SearchResponse, error)

	// BuildURL builds the search URL for the given query and page
	BuildURL(query string, page int) string

	// ParseResponse parses the HTML response and extracts results
	ParseResponse(html string) *parser.ExtractionResult

	// IsBlocked checks if the response indicates we're blocked
	IsBlocked(html string) bool

	// IsCaptcha checks if the response is a CAPTCHA page
	IsCaptcha(html string) bool

	// GetDomains returns the list of domains for this engine
	GetDomains() []string
}

// SearchRequest represents a search request
type SearchRequest struct {
	ID          string
	Dork        string
	Page        int
	Proxy       *proxy.Proxy
	UserAgent   string
	Headers     map[string]string
	Timeout     time.Duration
	RetryCount  int
}

// SearchResponse represents a search response
type SearchResponse struct {
	RequestID    string
	Dork         string
	Page         int
	URLs         []string
	RawURLs      []string
	HasNextPage  bool
	TotalResults string
	StatusCode   int
	Blocked      bool
	Captcha      bool
	Error        error
	Latency      time.Duration
	ProxyUsed    string
	EngineUsed   string
	HTML         string // Raw HTML (optional, for debugging)
}

// EngineType represents the type of search engine
type EngineType string

const (
	EngineTypeGoogle     EngineType = "google"
	EngineTypeBing       EngineType = "bing"
	EngineTypeYahoo      EngineType = "yahoo"
	EngineTypeDuckDuckGo EngineType = "duckduckgo"
	EngineTypeYandex     EngineType = "yandex"
	EngineTypeAsk        EngineType = "ask"
)

// EngineConfig holds configuration for an engine
type EngineConfig struct {
	Type            EngineType
	Enabled         bool
	Weight          float64 // For load balancing between engines
	ResultsPerPage  int
	MaxPages        int
	Domains         []string
	CustomHeaders   map[string]string
	RateLimitPerMin int
}

// DefaultEngineConfigs returns default configurations for all engines
func DefaultEngineConfigs() map[EngineType]EngineConfig {
	return map[EngineType]EngineConfig{
		EngineTypeGoogle: {
			Type:           EngineTypeGoogle,
			Enabled:        true,
			Weight:         1.0,
			ResultsPerPage: 10,
			MaxPages:       10,
			Domains: []string{
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
				"www.google.pl",
				"www.google.ru",
				"www.google.co.jp",
				"www.google.co.kr",
				"www.google.com.br",
				"www.google.com.mx",
				"www.google.co.in",
				"www.google.com.sg",
			},
			RateLimitPerMin: 20,
		},
		EngineTypeBing: {
			Type:           EngineTypeBing,
			Enabled:        false, // Disabled by default, enable later
			Weight:         0.5,
			ResultsPerPage: 10,
			MaxPages:       10,
			Domains: []string{
				"www.bing.com",
			},
			RateLimitPerMin: 30,
		},
		EngineTypeYahoo: {
			Type:           EngineTypeYahoo,
			Enabled:        false,
			Weight:         0.3,
			ResultsPerPage: 10,
			MaxPages:       10,
			Domains: []string{
				"search.yahoo.com",
			},
			RateLimitPerMin: 30,
		},
		EngineTypeDuckDuckGo: {
			Type:           EngineTypeDuckDuckGo,
			Enabled:        false,
			Weight:         0.4,
			ResultsPerPage: 10,
			MaxPages:       5,
			Domains: []string{
				"duckduckgo.com",
				"html.duckduckgo.com",
			},
			RateLimitPerMin: 20,
		},
		EngineTypeYandex: {
			Type:           EngineTypeYandex,
			Enabled:        false,
			Weight:         0.3,
			ResultsPerPage: 10,
			MaxPages:       10,
			Domains: []string{
				"yandex.com",
				"yandex.ru",
			},
			RateLimitPerMin: 20,
		},
		EngineTypeAsk: {
			Type:           EngineTypeAsk,
			Enabled:        false,
			Weight:         0.2,
			ResultsPerPage: 10,
			MaxPages:       5,
			Domains: []string{
				"www.ask.com",
			},
			RateLimitPerMin: 30,
		},
	}
}

// Registry holds all registered engines
type Registry struct {
	engines map[EngineType]Engine
	configs map[EngineType]EngineConfig
}

// NewRegistry creates a new engine registry
func NewRegistry() *Registry {
	return &Registry{
		engines: make(map[EngineType]Engine),
		configs: DefaultEngineConfigs(),
	}
}

// Register registers an engine
func (r *Registry) Register(engineType EngineType, engine Engine) {
	r.engines[engineType] = engine
}

// Get returns an engine by type
func (r *Registry) Get(engineType EngineType) (Engine, bool) {
	engine, ok := r.engines[engineType]
	return engine, ok
}

// GetEnabled returns all enabled engines
func (r *Registry) GetEnabled() []Engine {
	engines := make([]Engine, 0)
	for engineType, engine := range r.engines {
		if config, ok := r.configs[engineType]; ok && config.Enabled {
			engines = append(engines, engine)
		}
	}
	return engines
}

// GetConfig returns the configuration for an engine
func (r *Registry) GetConfig(engineType EngineType) (EngineConfig, bool) {
	config, ok := r.configs[engineType]
	return config, ok
}

// SetConfig sets the configuration for an engine
func (r *Registry) SetConfig(engineType EngineType, config EngineConfig) {
	r.configs[engineType] = config
}

// Enable enables an engine
func (r *Registry) Enable(engineType EngineType) {
	if config, ok := r.configs[engineType]; ok {
		config.Enabled = true
		r.configs[engineType] = config
	}
}

// Disable disables an engine
func (r *Registry) Disable(engineType EngineType) {
	if config, ok := r.configs[engineType]; ok {
		config.Enabled = false
		r.configs[engineType] = config
	}
}

// List returns all registered engine types
func (r *Registry) List() []EngineType {
	types := make([]EngineType, 0, len(r.engines))
	for t := range r.engines {
		types = append(types, t)
	}
	return types
}

// BaseEngine provides common functionality for engines
type BaseEngine struct {
	name      string
	domains   []string
	extractor *parser.Extractor
}

// NewBaseEngine creates a new base engine
func NewBaseEngine(name string, domains []string) *BaseEngine {
	cleaner := parser.NewURLCleaner(parser.DefaultCleanerConfig())
	return &BaseEngine{
		name:      name,
		domains:   domains,
		extractor: parser.NewExtractor(cleaner),
	}
}

// Name returns the engine name
func (e *BaseEngine) Name() string {
	return e.name
}

// GetDomains returns the engine domains
func (e *BaseEngine) GetDomains() []string {
	return e.domains
}

// GetExtractor returns the URL extractor
func (e *BaseEngine) GetExtractor() *parser.Extractor {
	return e.extractor
}

// ParseResponse parses HTML using the extractor
func (e *BaseEngine) ParseResponse(html string) *parser.ExtractionResult {
	return e.extractor.ExtractFromHTML(html)
}

// IsBlocked checks if blocked
func (e *BaseEngine) IsBlocked(html string) bool {
	return e.extractor.IsBlocked(html)
}

// IsCaptcha checks if CAPTCHA
func (e *BaseEngine) IsCaptcha(html string) bool {
	return e.extractor.IsCaptcha(html)
}

// SearchError represents a search error
type SearchError struct {
	Type    SearchErrorType
	Message string
	Err     error
}

// SearchErrorType defines types of search errors
type SearchErrorType string

const (
	ErrorTypeNetwork   SearchErrorType = "network"
	ErrorTypeTimeout   SearchErrorType = "timeout"
	ErrorTypeBlocked   SearchErrorType = "blocked"
	ErrorTypeCaptcha   SearchErrorType = "captcha"
	ErrorTypeRateLimit SearchErrorType = "rate_limit"
	ErrorTypeParse     SearchErrorType = "parse"
	ErrorTypeProxy     SearchErrorType = "proxy"
	ErrorTypeUnknown   SearchErrorType = "unknown"
)

func (e *SearchError) Error() string {
	if e.Err != nil {
		return e.Message + ": " + e.Err.Error()
	}
	return e.Message
}

// NewSearchError creates a new search error
func NewSearchError(errType SearchErrorType, message string, err error) *SearchError {
	return &SearchError{
		Type:    errType,
		Message: message,
		Err:     err,
	}
}
