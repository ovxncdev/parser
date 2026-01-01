package proxy

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Protocol represents proxy protocol type
type Protocol string

const (
	ProtocolHTTP   Protocol = "http"
	ProtocolHTTPS  Protocol = "https"
	ProtocolSOCKS4 Protocol = "socks4"
	ProtocolSOCKS5 Protocol = "socks5"
)

// Status represents proxy health status
type Status string

const (
	StatusUnknown     Status = "unknown"
	StatusAlive       Status = "alive"
	StatusDead        Status = "dead"
	StatusSlow        Status = "slow"
	StatusQuarantined Status = "quarantined"
	StatusBanned      Status = "banned"
)

// Proxy represents a single proxy
type Proxy struct {
	ID           string
	Host         string
	Port         string
	Username     string
	Password     string
	Protocol     Protocol
	Status       Status
	Latency      time.Duration
	LastCheck    time.Time
	LastUsed     time.Time
	SuccessCount int64
	FailCount    int64
	CaptchaCount int64
	BanCount     int64
	QuarantineUntil time.Time
	Metadata     map[string]string
}

// Manager manages the proxy pool
type Manager struct {
	mu            sync.RWMutex
	proxies       map[string]*Proxy
	alive         []*Proxy
	quarantined   []*Proxy
	dead          []*Proxy
	quarantineDur time.Duration
	maxFailCount  int
}

// ManagerConfig holds manager configuration
type ManagerConfig struct {
	QuarantineDuration time.Duration
	MaxFailCount       int
}

// DefaultManagerConfig returns default configuration
func DefaultManagerConfig() ManagerConfig {
	return ManagerConfig{
		QuarantineDuration: 5 * time.Minute,
		MaxFailCount:       5,
	}
}

// NewManager creates a new proxy manager
func NewManager(config ManagerConfig) *Manager {
	return &Manager{
		proxies:       make(map[string]*Proxy),
		alive:         make([]*Proxy, 0),
		quarantined:   make([]*Proxy, 0),
		dead:          make([]*Proxy, 0),
		quarantineDur: config.QuarantineDuration,
		maxFailCount:  config.MaxFailCount,
	}
}

// LoadFromFile loads proxies from a file
func (m *Manager) LoadFromFile(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("failed to open proxy file: %w", err)
	}
	defer file.Close()

	count := 0
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		proxy, err := ParseProxy(line)
		if err != nil {
			continue // Skip invalid proxies
		}

		m.Add(proxy)
		count++
	}

	if err := scanner.Err(); err != nil {
		return count, fmt.Errorf("error reading proxy file: %w", err)
	}

	return count, nil
}

// LoadFromSlice loads proxies from a string slice
func (m *Manager) LoadFromSlice(proxies []string) int {
	count := 0
	for _, line := range proxies {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		proxy, err := ParseProxy(line)
		if err != nil {
			continue
		}

		m.Add(proxy)
		count++
	}
	return count
}

// Add adds a proxy to the pool
func (m *Manager) Add(proxy *Proxy) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.proxies[proxy.ID]; exists {
		return // Already exists
	}

	proxy.Status = StatusUnknown
	m.proxies[proxy.ID] = proxy
	m.alive = append(m.alive, proxy)
}

// Remove removes a proxy from the pool
func (m *Manager) Remove(proxyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	delete(m.proxies, proxyID)
	m.removeFromSlice(&m.alive, proxy)
	m.removeFromSlice(&m.quarantined, proxy)
	m.removeFromSlice(&m.dead, proxy)
}

// Get returns a proxy by ID
func (m *Manager) Get(proxyID string) *Proxy {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.proxies[proxyID]
}

// GetAlive returns all alive proxies
func (m *Manager) GetAlive() []*Proxy {
	m.mu.RLock()
	defer m.mu.RUnlock()

	// Check and release quarantined proxies
	m.checkQuarantine()

	result := make([]*Proxy, len(m.alive))
	copy(result, m.alive)
	return result
}

// GetAll returns all proxies
func (m *Manager) GetAll() []*Proxy {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]*Proxy, 0, len(m.proxies))
	for _, proxy := range m.proxies {
		result = append(result, proxy)
	}
	return result
}

// Count returns proxy counts by status
func (m *Manager) Count() (total, alive, quarantined, dead int) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return len(m.proxies), len(m.alive), len(m.quarantined), len(m.dead)
}

// MarkAlive marks a proxy as alive
func (m *Manager) MarkAlive(proxyID string, latency time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	wasQuarantined := proxy.Status == StatusQuarantined
	wasDead := proxy.Status == StatusDead

	proxy.Status = StatusAlive
	proxy.Latency = latency
	proxy.LastCheck = time.Now()
	proxy.SuccessCount++
	proxy.FailCount = 0 // Reset fail count on success

	if wasQuarantined {
		m.removeFromSlice(&m.quarantined, proxy)
		m.alive = append(m.alive, proxy)
	} else if wasDead {
		m.removeFromSlice(&m.dead, proxy)
		m.alive = append(m.alive, proxy)
	}
}

// MarkSlow marks a proxy as slow
func (m *Manager) MarkSlow(proxyID string, latency time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	proxy.Status = StatusSlow
	proxy.Latency = latency
	proxy.LastCheck = time.Now()
	proxy.SuccessCount++
}

// MarkFailed marks a proxy as failed
func (m *Manager) MarkFailed(proxyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	proxy.FailCount++
	proxy.LastCheck = time.Now()

	if proxy.FailCount >= int64(m.maxFailCount) {
		m.quarantineProxy(proxy)
	}
}

// MarkDead marks a proxy as dead
func (m *Manager) MarkDead(proxyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	proxy.Status = StatusDead
	proxy.LastCheck = time.Now()

	m.removeFromSlice(&m.alive, proxy)
	m.removeFromSlice(&m.quarantined, proxy)
	if !m.inSlice(m.dead, proxy) {
		m.dead = append(m.dead, proxy)
	}
}

// MarkBanned marks a proxy as banned
func (m *Manager) MarkBanned(proxyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	proxy.Status = StatusBanned
	proxy.BanCount++
	proxy.LastCheck = time.Now()

	// Longer quarantine for banned proxies
	proxy.QuarantineUntil = time.Now().Add(m.quarantineDur * 3)
	m.removeFromSlice(&m.alive, proxy)
	if !m.inSlice(m.quarantined, proxy) {
		m.quarantined = append(m.quarantined, proxy)
	}
}

// MarkCaptcha marks a proxy as having hit CAPTCHA
func (m *Manager) MarkCaptcha(proxyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	proxy.CaptchaCount++
	proxy.LastCheck = time.Now()

	// Quarantine on CAPTCHA
	m.quarantineProxy(proxy)
}

// RecordUsage records that a proxy was used
func (m *Manager) RecordUsage(proxyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	proxy.LastUsed = time.Now()
}

// Quarantine puts a proxy in quarantine
func (m *Manager) Quarantine(proxyID string, duration time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()

	proxy, ok := m.proxies[proxyID]
	if !ok {
		return
	}

	proxy.QuarantineUntil = time.Now().Add(duration)
	m.quarantineProxy(proxy)
}

func (m *Manager) quarantineProxy(proxy *Proxy) {
	proxy.Status = StatusQuarantined
	if proxy.QuarantineUntil.IsZero() {
		proxy.QuarantineUntil = time.Now().Add(m.quarantineDur)
	}

	m.removeFromSlice(&m.alive, proxy)
	if !m.inSlice(m.quarantined, proxy) {
		m.quarantined = append(m.quarantined, proxy)
	}
}

func (m *Manager) checkQuarantine() {
	now := time.Now()
	toRelease := make([]*Proxy, 0)

	for _, proxy := range m.quarantined {
		if now.After(proxy.QuarantineUntil) {
			toRelease = append(toRelease, proxy)
		}
	}

	for _, proxy := range toRelease {
		proxy.Status = StatusAlive
		proxy.FailCount = 0
		m.removeFromSlice(&m.quarantined, proxy)
		m.alive = append(m.alive, proxy)
	}
}

// Stats returns statistics about the proxy pool
func (m *Manager) Stats() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var totalLatency time.Duration
	var latencyCount int
	var totalSuccess, totalFail, totalCaptcha, totalBan int64

	for _, proxy := range m.proxies {
		if proxy.Latency > 0 {
			totalLatency += proxy.Latency
			latencyCount++
		}
		totalSuccess += proxy.SuccessCount
		totalFail += proxy.FailCount
		totalCaptcha += proxy.CaptchaCount
		totalBan += proxy.BanCount
	}

	avgLatency := time.Duration(0)
	if latencyCount > 0 {
		avgLatency = totalLatency / time.Duration(latencyCount)
	}

	successRate := float64(0)
	if totalSuccess+totalFail > 0 {
		successRate = float64(totalSuccess) / float64(totalSuccess+totalFail) * 100
	}

	return map[string]interface{}{
		"total":         len(m.proxies),
		"alive":         len(m.alive),
		"quarantined":   len(m.quarantined),
		"dead":          len(m.dead),
		"avg_latency":   avgLatency,
		"total_success": totalSuccess,
		"total_fail":    totalFail,
		"total_captcha": totalCaptcha,
		"total_ban":     totalBan,
		"success_rate":  successRate,
	}
}

func (m *Manager) removeFromSlice(slice *[]*Proxy, proxy *Proxy) {
	for i, p := range *slice {
		if p.ID == proxy.ID {
			*slice = append((*slice)[:i], (*slice)[i+1:]...)
			return
		}
	}
}

func (m *Manager) inSlice(slice []*Proxy, proxy *Proxy) bool {
	for _, p := range slice {
		if p.ID == proxy.ID {
			return true
		}
	}
	return false
}

// ParseProxy parses a proxy string into a Proxy struct
// Supports formats:
// - host:port
// - host:port:user:pass
// - user:pass@host:port
// - protocol://host:port
// - protocol://user:pass@host:port
func ParseProxy(s string) (*Proxy, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("empty proxy string")
	}

	proxy := &Proxy{
		Protocol: ProtocolHTTP,
		Status:   StatusUnknown,
		Metadata: make(map[string]string),
	}

	// Check for protocol prefix
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy URL: %w", err)
		}

		proxy.Protocol = Protocol(u.Scheme)
		proxy.Host = u.Hostname()
		proxy.Port = u.Port()

		if u.User != nil {
			proxy.Username = u.User.Username()
			proxy.Password, _ = u.User.Password()
		}
	} else {
		// Try different formats
		if strings.Contains(s, "@") {
			// user:pass@host:port
			parts := strings.SplitN(s, "@", 2)
			authParts := strings.SplitN(parts[0], ":", 2)
			hostParts := strings.SplitN(parts[1], ":", 2)

			if len(authParts) >= 1 {
				proxy.Username = authParts[0]
			}
			if len(authParts) >= 2 {
				proxy.Password = authParts[1]
			}
			if len(hostParts) >= 1 {
				proxy.Host = hostParts[0]
			}
			if len(hostParts) >= 2 {
				proxy.Port = hostParts[1]
			}
		} else {
			// host:port or host:port:user:pass
			parts := strings.Split(s, ":")
			if len(parts) >= 2 {
				proxy.Host = parts[0]
				proxy.Port = parts[1]
			}
			if len(parts) >= 4 {
				proxy.Username = parts[2]
				proxy.Password = parts[3]
			}
		}
	}

	// Validate
	if proxy.Host == "" || proxy.Port == "" {
		return nil, fmt.Errorf("invalid proxy format: %s", s)
	}

	// Validate host (basic check)
	if !isValidHost(proxy.Host) {
		return nil, fmt.Errorf("invalid host: %s", proxy.Host)
	}

	// Generate ID
	proxy.ID = fmt.Sprintf("%s:%s", proxy.Host, proxy.Port)

	return proxy, nil
}

// isValidHost checks if a host is valid (IP or domain)
func isValidHost(host string) bool {
	// IP pattern
	ipPattern := regexp.MustCompile(`^(\d{1,3}\.){3}\d{1,3}$`)
	if ipPattern.MatchString(host) {
		return true
	}

	// Domain pattern (basic)
	domainPattern := regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$`)
	return domainPattern.MatchString(host)
}

// URL returns the proxy URL string
func (p *Proxy) URL() string {
	var auth string
	if p.Username != "" {
		if p.Password != "" {
			auth = fmt.Sprintf("%s:%s@", p.Username, p.Password)
		} else {
			auth = fmt.Sprintf("%s@", p.Username)
		}
	}
	return fmt.Sprintf("%s://%s%s:%s", p.Protocol, auth, p.Host, p.Port)
}

// String returns a string representation
func (p *Proxy) String() string {
	return fmt.Sprintf("%s (%s) [%s]", p.ID, p.Protocol, p.Status)
}

// SuccessRate returns the success rate
func (p *Proxy) SuccessRate() float64 {
	total := p.SuccessCount + p.FailCount
	if total == 0 {
		return 0
	}
	return float64(p.SuccessCount) / float64(total) * 100
}
