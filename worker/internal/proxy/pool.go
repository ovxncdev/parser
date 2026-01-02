package proxy

import (
	"fmt"
	"math/rand"
	"sync"
	"time"
)

// PoolConfig holds configuration for the proxy pool
type PoolConfig struct {
	MaxFailures       int           `json:"max_failures"`        // Max failures before quarantine
	CooldownDuration  time.Duration `json:"cooldown_duration"`   // Cooldown after CAPTCHA/rate limit
	QuarantineDuration time.Duration `json:"quarantine_duration"` // How long to quarantine bad proxies
	HealthCheckInterval time.Duration `json:"health_check_interval"` // Interval between health checks
	MinSuccessRate    float64       `json:"min_success_rate"`    // Minimum success rate to stay active
}

// DefaultPoolConfig returns sensible defaults
func DefaultPoolConfig() PoolConfig {
	return PoolConfig{
		MaxFailures:        5,
		CooldownDuration:   30 * time.Second,
		QuarantineDuration: 5 * time.Minute,
		HealthCheckInterval: 1 * time.Minute,
		MinSuccessRate:     50.0,
	}
}

// Pool manages a collection of proxies with rotation and health tracking
type Pool struct {
	mu       sync.RWMutex
	proxies  map[string]*Proxy // All proxies by ID
	alive    []*Proxy          // Available proxies for rotation
	dead     []*Proxy          // Dead proxies
	quarantine []*Proxy        // Temporarily quarantined proxies

	config   PoolConfig
	rng      *rand.Rand
	stopCh   chan struct{}
	
	// Statistics
	totalRotations int64
	totalRequests  int64
}

// NewPool creates a new proxy pool
func NewPool(config PoolConfig) *Pool {
	return &Pool{
		proxies:    make(map[string]*Proxy),
		alive:      make([]*Proxy, 0),
		dead:       make([]*Proxy, 0),
		quarantine: make([]*Proxy, 0),
		config:     config,
		rng:        rand.New(rand.NewSource(time.Now().UnixNano())),
		stopCh:     make(chan struct{}),
	}
}

// AddProxy adds a proxy to the pool
func (p *Pool) AddProxy(proxy *Proxy) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if _, exists := p.proxies[proxy.ID]; exists {
		return fmt.Errorf("proxy %s already exists", proxy.ID)
	}

	proxy.Status = ProxyStatusAlive
	p.proxies[proxy.ID] = proxy
	p.alive = append(p.alive, proxy)

	return nil
}

// AddProxies adds multiple proxies to the pool
func (p *Pool) AddProxies(proxies []*Proxy) (added int, errors []error) {
	for _, proxy := range proxies {
		if err := p.AddProxy(proxy); err != nil {
			errors = append(errors, err)
		} else {
			added++
		}
	}
	return added, errors
}

// LoadFromFile loads proxies from a file
func (p *Pool) LoadFromFile(filepath string) (added int, errors []error) {
	parser := NewParser()
	proxies, parseErrors := parser.ParseFile(filepath)
	errors = append(errors, parseErrors...)

	addedCount, addErrors := p.AddProxies(proxies)
	errors = append(errors, addErrors...)

	return addedCount, errors
}

// Get returns an available proxy using weighted random selection
// Proxies with better success rates are more likely to be selected
func (p *Pool) Get() (*Proxy, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.totalRotations++

	// Filter available proxies
	available := make([]*Proxy, 0, len(p.alive))
	for _, proxy := range p.alive {
		if proxy.IsAvailable() {
			available = append(available, proxy)
		}
	}

	if len(available) == 0 {
		return nil, fmt.Errorf("no available proxies")
	}

	// Weighted random selection based on success rate
	proxy := p.weightedSelect(available)
	return proxy, nil
}

// weightedSelect selects a proxy based on success rate weights
func (p *Pool) weightedSelect(proxies []*Proxy) *Proxy {
	if len(proxies) == 1 {
		return proxies[0]
	}

	// Calculate weights
	weights := make([]float64, len(proxies))
	totalWeight := 0.0

	for i, proxy := range proxies {
		// Base weight of 1, plus success rate bonus
		weight := 1.0
		if proxy.TotalRequests > 0 {
			weight += proxy.SuccessRate() / 100.0 * 2.0 // Max bonus of 2.0
		}
		// Penalize slow proxies
		if proxy.AvgLatency() > 5*time.Second {
			weight *= 0.5
		}
		weights[i] = weight
		totalWeight += weight
	}

	// Random selection
	r := p.rng.Float64() * totalWeight
	cumulative := 0.0

	for i, weight := range weights {
		cumulative += weight
		if r <= cumulative {
			return proxies[i]
		}
	}

	// Fallback to last proxy
	return proxies[len(proxies)-1]
}

// GetByID returns a specific proxy by ID
func (p *Pool) GetByID(id string) (*Proxy, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	proxy, exists := p.proxies[id]
	return proxy, exists
}

// ReportSuccess reports a successful request for a proxy
func (p *Pool) ReportSuccess(proxyID string, latency time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()

	proxy, exists := p.proxies[proxyID]
	if !exists {
		return
	}

	proxy.RecordSuccess(latency)
	p.totalRequests++
}

// ReportFailure reports a failed request for a proxy
func (p *Pool) ReportFailure(proxyID string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	proxy, exists := p.proxies[proxyID]
	if !exists {
		return
	}

	proxy.RecordFail()
	p.totalRequests++

	// Check if should be quarantined
	if proxy.FailCount >= int64(p.config.MaxFailures) {
		p.quarantineProxy(proxy)
	}
}

// ReportCaptcha reports a CAPTCHA encounter for a proxy
func (p *Pool) ReportCaptcha(proxyID string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	proxy, exists := p.proxies[proxyID]
	if !exists {
		return
	}

	proxy.RecordCaptcha()
	proxy.SetCooldown(p.config.CooldownDuration)
}

// ReportBlock reports that a proxy has been blocked
func (p *Pool) ReportBlock(proxyID string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	proxy, exists := p.proxies[proxyID]
	if !exists {
		return
	}

	p.quarantineProxy(proxy)
}

// quarantineProxy moves a proxy to quarantine (must hold lock)
func (p *Pool) quarantineProxy(proxy *Proxy) {
	proxy.Status = ProxyStatusQuarantined
	proxy.SetCooldown(p.config.QuarantineDuration)

	// Remove from alive list
	for i, ap := range p.alive {
		if ap.ID == proxy.ID {
			p.alive = append(p.alive[:i], p.alive[i+1:]...)
			break
		}
	}

	p.quarantine = append(p.quarantine, proxy)
}

// markDead marks a proxy as permanently dead (must hold lock)
func (p *Pool) markDead(proxy *Proxy) {
	proxy.Status = ProxyStatusDead

	// Remove from alive list
	for i, ap := range p.alive {
		if ap.ID == proxy.ID {
			p.alive = append(p.alive[:i], p.alive[i+1:]...)
			break
		}
	}

	// Remove from quarantine if present
	for i, qp := range p.quarantine {
		if qp.ID == proxy.ID {
			p.quarantine = append(p.quarantine[:i], p.quarantine[i+1:]...)
			break
		}
	}

	p.dead = append(p.dead, proxy)
}

// reviveProxy moves a proxy from quarantine back to alive (must hold lock)
func (p *Pool) reviveProxy(proxy *Proxy) {
	proxy.Status = ProxyStatusAlive
	proxy.FailCount = 0 // Reset fail count

	// Remove from quarantine
	for i, qp := range p.quarantine {
		if qp.ID == proxy.ID {
			p.quarantine = append(p.quarantine[:i], p.quarantine[i+1:]...)
			break
		}
	}

	p.alive = append(p.alive, proxy)
}

// StartHealthCheck starts the background health check routine
func (p *Pool) StartHealthCheck() {
	go func() {
		ticker := time.NewTicker(p.config.HealthCheckInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				p.performHealthCheck()
			case <-p.stopCh:
				return
			}
		}
	}()
}

// StopHealthCheck stops the background health check
func (p *Pool) StopHealthCheck() {
	close(p.stopCh)
}

// performHealthCheck checks quarantined proxies and revives eligible ones
func (p *Pool) performHealthCheck() {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now()

	// Check quarantined proxies
	toRevive := make([]*Proxy, 0)
	for _, proxy := range p.quarantine {
		if now.After(proxy.CooldownUntil) {
			toRevive = append(toRevive, proxy)
		}
	}

	for _, proxy := range toRevive {
		p.reviveProxy(proxy)
	}

	// Check alive proxies for poor performance
	for _, proxy := range p.alive {
		if proxy.TotalRequests >= 10 && proxy.SuccessRate() < p.config.MinSuccessRate {
			p.quarantineProxy(proxy)
		}
	}
}

// Stats returns current pool statistics
func (p *Pool) Stats() PoolStats {
	p.mu.RLock()
	defer p.mu.RUnlock()

	stats := PoolStats{
		Total:       len(p.proxies),
		Alive:       len(p.alive),
		Dead:        len(p.dead),
		Quarantined: len(p.quarantine),
		Rotations:   p.totalRotations,
		Requests:    p.totalRequests,
	}

	// Calculate available (not on cooldown)
	for _, proxy := range p.alive {
		if proxy.IsAvailable() {
			stats.Available++
		}
	}

	// Calculate average success rate
	totalRate := 0.0
	counted := 0
	for _, proxy := range p.alive {
		if proxy.TotalRequests > 0 {
			totalRate += proxy.SuccessRate()
			counted++
		}
	}
	if counted > 0 {
		stats.AvgSuccessRate = totalRate / float64(counted)
	}

	return stats
}

// PoolStats holds pool statistics
type PoolStats struct {
	Total          int     `json:"total"`
	Alive          int     `json:"alive"`
	Available      int     `json:"available"`
	Dead           int     `json:"dead"`
	Quarantined    int     `json:"quarantined"`
	Rotations      int64   `json:"rotations"`
	Requests       int64   `json:"requests"`
	AvgSuccessRate float64 `json:"avg_success_rate"`
}

// AlivePercentage returns the percentage of alive proxies
func (s PoolStats) AlivePercentage() float64 {
	if s.Total == 0 {
		return 0
	}
	return float64(s.Alive) / float64(s.Total) * 100
}

// GetAllAlive returns all alive proxies (for display purposes)
func (p *Pool) GetAllAlive() []*Proxy {
	p.mu.RLock()
	defer p.mu.RUnlock()

	result := make([]*Proxy, len(p.alive))
	copy(result, p.alive)
	return result
}

// GetAllDead returns all dead proxies (for display purposes)
func (p *Pool) GetAllDead() []*Proxy {
	p.mu.RLock()
	defer p.mu.RUnlock()

	result := make([]*Proxy, len(p.dead))
	copy(result, p.dead)
	return result
}

// GetAllQuarantined returns all quarantined proxies (for display purposes)
func (p *Pool) GetAllQuarantined() []*Proxy {
	p.mu.RLock()
	defer p.mu.RUnlock()

	result := make([]*Proxy, len(p.quarantine))
	copy(result, p.quarantine)
	return result
}

// RecommendedWorkers returns recommended worker count based on pool size
func (p *Pool) RecommendedWorkers() int {
	p.mu.RLock()
	defer p.mu.RUnlock()

	alive := len(p.alive)
	if alive == 0 {
		return 0
	}

	// 1 worker per 10 proxies, min 1, max 200
	workers := alive / 10
	if workers < 1 {
		workers = 1
	}
	if workers > 200 {
		workers = 200
	}

	return workers
}
