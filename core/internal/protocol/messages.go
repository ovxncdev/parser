package protocol

import (
	"encoding/json"
	"time"
)

// MessageType defines the type of message
type MessageType string

const (
	// Incoming messages (from TypeScript)
	MsgTypeInit     MessageType = "init"
	MsgTypeTask     MessageType = "task"
	MsgTypePause    MessageType = "pause"
	MsgTypeResume   MessageType = "resume"
	MsgTypeStop     MessageType = "stop"
	MsgTypeHealth   MessageType = "health"
	MsgTypeAddProxy MessageType = "add_proxy"
	MsgTypeDelProxy MessageType = "del_proxy"

	// Outgoing messages (to TypeScript)
	MsgTypeReady       MessageType = "ready"
	MsgTypeResult      MessageType = "result"
	MsgTypeError       MessageType = "error"
	MsgTypeBlocked     MessageType = "blocked"
	MsgTypeProgress    MessageType = "progress"
	MsgTypeProxyStatus MessageType = "proxy_status"
	MsgTypeStats       MessageType = "stats"
	MsgTypeDone        MessageType = "done"
)

// BlockReason defines why a request was blocked
type BlockReason string

const (
	BlockCaptcha    BlockReason = "captcha"
	BlockRateLimit  BlockReason = "rate_limit"
	BlockBanned     BlockReason = "banned"
	BlockTimeout    BlockReason = "timeout"
	BlockProxyDead  BlockReason = "proxy_dead"
	BlockEmptyPage  BlockReason = "empty_page"
	BlockUnknown    BlockReason = "unknown"
)

// ProxyStatus defines proxy health states
type ProxyStatus string

const (
	ProxyAlive       ProxyStatus = "alive"
	ProxyDead        ProxyStatus = "dead"
	ProxySlow        ProxyStatus = "slow"
	ProxyQuarantined ProxyStatus = "quarantined"
)

// Engine defines available search engines
type Engine string

const (
	EngineGoogle     Engine = "google"
	EngineBing       Engine = "bing"
	EngineYahoo      Engine = "yahoo"
	EngineDuckDuckGo Engine = "duckduckgo"
	EngineYandex     Engine = "yandex"
	EngineAsk        Engine = "ask"
)

// BaseMessage is the common structure for all messages
type BaseMessage struct {
	Type      MessageType `json:"type"`
	Timestamp int64       `json:"timestamp"`
	ID        string      `json:"id,omitempty"`
}

// --- Incoming Messages ---

// InitMessage initializes the engine with configuration
type InitMessage struct {
	BaseMessage
	Config EngineConfig `json:"config"`
}

// EngineConfig holds all engine configuration
type EngineConfig struct {
	Engine           Engine   `json:"engine"`
	Workers          int      `json:"workers"`
	PagesPerDork     int      `json:"pages_per_dork"`
	Timeout          int      `json:"timeout_ms"`
	DelayMin         int      `json:"delay_min_ms"`
	DelayMax         int      `json:"delay_max_ms"`
	RetryAttempts    int      `json:"retry_attempts"`
	ProxyRotateAfter int      `json:"proxy_rotate_after"`
	UserAgents       []string `json:"user_agents"`
	GoogleDomains    []string `json:"google_domains"`
}

// TaskMessage assigns a search task
type TaskMessage struct {
	BaseMessage
	TaskID string `json:"task_id"`
	Dork   string `json:"dork"`
	Proxy  string `json:"proxy,omitempty"`
	Page   int    `json:"page"`
}

// ProxyMessage adds or removes a proxy
type ProxyMessage struct {
	BaseMessage
	Proxy    string `json:"proxy"`
	Protocol string `json:"protocol"` // http, socks4, socks5
}

// --- Outgoing Messages ---

// ReadyMessage signals engine is ready
type ReadyMessage struct {
	BaseMessage
	Version     string `json:"version"`
	GoVersion   string `json:"go_version"`
	MaxWorkers  int    `json:"max_workers"`
	ProxyCount  int    `json:"proxy_count"`
}

// ResultMessage contains search results
type ResultMessage struct {
	BaseMessage
	TaskID      string   `json:"task_id"`
	Dork        string   `json:"dork"`
	Page        int      `json:"page"`
	URLs        []string `json:"urls"`
	RawURLs     []string `json:"raw_urls"`
	HasNextPage bool     `json:"has_next_page"`
	TimeTaken   int64    `json:"time_taken_ms"`
	ProxyUsed   string   `json:"proxy_used"`
}

// ErrorMessage reports an error
type ErrorMessage struct {
	BaseMessage
	TaskID  string `json:"task_id,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Fatal   bool   `json:"fatal"`
}

// BlockedMessage reports a blocked request
type BlockedMessage struct {
	BaseMessage
	TaskID string      `json:"task_id"`
	Dork   string      `json:"dork"`
	Proxy  string      `json:"proxy"`
	Reason BlockReason `json:"reason"`
	Detail string      `json:"detail,omitempty"`
}

// ProgressMessage reports progress
type ProgressMessage struct {
	BaseMessage
	Completed   int `json:"completed"`
	Total       int `json:"total"`
	URLsFound   int `json:"urls_found"`
	ActiveTasks int `json:"active_tasks"`
}

// ProxyStatusMessage reports proxy health
type ProxyStatusMessage struct {
	BaseMessage
	Proxy       string      `json:"proxy"`
	Status      ProxyStatus `json:"status"`
	Latency     int64       `json:"latency_ms"`
	SuccessRate float64     `json:"success_rate"`
	LastUsed    int64       `json:"last_used"`
	FailCount   int         `json:"fail_count"`
}

// StatsMessage reports overall statistics
type StatsMessage struct {
	BaseMessage
	Uptime          int64   `json:"uptime_ms"`
	TotalRequests   int64   `json:"total_requests"`
	SuccessRequests int64   `json:"success_requests"`
	FailedRequests  int64   `json:"failed_requests"`
	TotalURLs       int64   `json:"total_urls"`
	UniqueURLs      int64   `json:"unique_urls"`
	RequestsPerMin  float64 `json:"requests_per_min"`
	URLsPerMin      float64 `json:"urls_per_min"`
	AvgLatency      float64 `json:"avg_latency_ms"`
	ActiveProxies   int     `json:"active_proxies"`
	DeadProxies     int     `json:"dead_proxies"`
	MemoryUsage     uint64  `json:"memory_usage_bytes"`
}

// DoneMessage signals task completion
type DoneMessage struct {
	BaseMessage
	TaskID    string `json:"task_id"`
	TotalURLs int    `json:"total_urls"`
	TimeTaken int64  `json:"time_taken_ms"`
}

// --- Helper Functions ---

// NewBaseMessage creates a base message with timestamp
func NewBaseMessage(msgType MessageType) BaseMessage {
	return BaseMessage{
		Type:      msgType,
		Timestamp: time.Now().UnixMilli(),
	}
}

// Parse parses a raw JSON message and returns the type
func Parse(data []byte) (MessageType, error) {
	var base BaseMessage
	if err := json.Unmarshal(data, &base); err != nil {
		return "", err
	}
	return base.Type, nil
}

// ParseInit parses an init message
func ParseInit(data []byte) (*InitMessage, error) {
	var msg InitMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ParseTask parses a task message
func ParseTask(data []byte) (*TaskMessage, error) {
	var msg TaskMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ParseProxy parses a proxy message
func ParseProxy(data []byte) (*ProxyMessage, error) {
	var msg ProxyMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// ToJSON converts a message to JSON bytes
func ToJSON(msg interface{}) ([]byte, error) {
	return json.Marshal(msg)
}

// MustJSON converts a message to JSON bytes, panics on error
func MustJSON(msg interface{}) []byte {
	data, err := json.Marshal(msg)
	if err != nil {
		panic(err)
	}
	return data
}
