package proxy

import (
	"math/rand"
	"sync"
	"sync/atomic"
	"time"
)

// RotationStrategy defines how proxies are rotated
type RotationStrategy string

const (
	StrategyRoundRobin   RotationStrategy = "round_robin"
	StrategyRandom       RotationStrategy = "random"
	StrategyLeastUsed    RotationStrategy = "least_used"
	StrategyLeastLatency RotationStrategy = "least_latency"
	StrategyWeighted     RotationStrategy = "weighted"
)

// Rotator handles proxy rotation
type Rotator struct {
	manager       *Manager
	strategy      RotationStrategy
	mu            sync.RWMutex
	currentIndex  uint64
	usageCount    map[string]int64
	rotateAfter   int
	requestCount  map[string]int
	stickySession map[string]string // task -> proxy mapping
	rng           *rand.Rand
}

// RotatorConfig holds rotator configuration
type RotatorConfig struct {
	Strategy     RotationStrategy
	RotateAfter  int  // Rotate after N requests per proxy
	StickyTasks  bool // Keep same proxy for same task
}

// DefaultRotatorConfig returns default configuration
func DefaultRotatorConfig() RotatorConfig {
	return RotatorConfig{
		Strategy:    StrategyRoundRobin,
		RotateAfter: 1, // Rotate every request by default
		StickyTasks: false,
	}
}

// NewRotator creates a new proxy rotator
func NewRotator(manager *Manager, config RotatorConfig) *Rotator {
	return &Rotator{
		manager:       manager,
		strategy:      config.Strategy,
		usageCount:    make(map[string]int64),
		rotateAfter:   config.RotateAfter,
		requestCount:  make(map[string]int),
		stickySession: make(map[string]string),
		rng:           rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// Next returns the next proxy to use
func (r *Rotator) Next() *Proxy {
	r.mu.Lock()
	defer r.mu.Unlock()

	proxies := r.manager.GetAlive()
	if len(proxies) == 0 {
		return nil
	}

	var proxy *Proxy

	switch r.strategy {
	case StrategyRoundRobin:
		proxy = r.roundRobin(proxies)
	case StrategyRandom:
		proxy = r.random(proxies)
	case StrategyLeastUsed:
		proxy = r.leastUsed(proxies)
	case StrategyLeastLatency:
		proxy = r.leastLatency(proxies)
	case StrategyWeighted:
		proxy = r.weighted(proxies)
	default:
		proxy = r.roundRobin(proxies)
	}

	if proxy != nil {
		r.usageCount[proxy.ID]++
		r.manager.RecordUsage(proxy.ID)
	}

	return proxy
}

// NextForTask returns a proxy for a specific task (supports sticky sessions)
func (r *Rotator) NextForTask(taskID string) *Proxy {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Check for sticky session
	if proxyID, ok := r.stickySession[taskID]; ok {
		proxy := r.manager.Get(proxyID)
		if proxy != nil && proxy.Status == StatusAlive {
			r.usageCount[proxy.ID]++
			r.manager.RecordUsage(proxy.ID)
			return proxy
		}
		// Proxy no longer valid, remove sticky session
		delete(r.stickySession, taskID)
	}

	proxies := r.manager.GetAlive()
	if len(proxies) == 0 {
		return nil
	}

	var proxy *Proxy

	switch r.strategy {
	case StrategyRoundRobin:
		proxy = r.roundRobin(proxies)
	case StrategyRandom:
		proxy = r.random(proxies)
	case StrategyLeastUsed:
		proxy = r.leastUsed(proxies)
	case StrategyLeastLatency:
		proxy = r.leastLatency(proxies)
	case StrategyWeighted:
		proxy = r.weighted(proxies)
	default:
		proxy = r.roundRobin(proxies)
	}

	if proxy != nil {
		r.usageCount[proxy.ID]++
		r.manager.RecordUsage(proxy.ID)
		r.stickySession[taskID] = proxy.ID
	}

	return proxy
}

// NextN returns N different proxies
func (r *Rotator) NextN(n int) []*Proxy {
	r.mu.Lock()
	defer r.mu.Unlock()

	proxies := r.manager.GetAlive()
	if len(proxies) == 0 {
		return nil
	}

	if n > len(proxies) {
		n = len(proxies)
	}

	// Shuffle and take first N
	shuffled := make([]*Proxy, len(proxies))
	copy(shuffled, proxies)
	r.rng.Shuffle(len(shuffled), func(i, j int) {
		shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
	})

	result := shuffled[:n]

	for _, proxy := range result {
		r.usageCount[proxy.ID]++
		r.manager.RecordUsage(proxy.ID)
	}

	return result
}

// ShouldRotate checks if proxy should be rotated based on request count
func (r *Rotator) ShouldRotate(proxyID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	count := r.requestCount[proxyID]
	return count >= r.rotateAfter
}

// RecordRequest records a request for rotation tracking
func (r *Rotator) RecordRequest(proxyID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.requestCount[proxyID]++
	if r.requestCount[proxyID] >= r.rotateAfter {
		r.requestCount[proxyID] = 0
	}
}

// ResetRequestCount resets request count for a proxy
func (r *Rotator) ResetRequestCount(proxyID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.requestCount[proxyID] = 0
}

// ClearStickySession clears sticky session for a task
func (r *Rotator) ClearStickySession(taskID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.stickySession, taskID)
}

// ClearAllStickySessions clears all sticky sessions
func (r *Rotator) ClearAllStickySessions() {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.stickySession = make(map[string]string)
}

// SetStrategy changes the rotation strategy
func (r *Rotator) SetStrategy(strategy RotationStrategy) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.strategy = strategy
}

// GetStrategy returns current strategy
func (r *Rotator) GetStrategy() RotationStrategy {
	r.mu.RLock()
	defer r.mu.RUnlock()

	return r.strategy
}

// SetRotateAfter changes the rotate after count
func (r *Rotator) SetRotateAfter(count int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.rotateAfter = count
}

// Stats returns rotation statistics
func (r *Rotator) Stats() map[string]interface{} {
	r.mu.RLock()
	defer r.mu.RUnlock()

	totalUsage := int64(0)
	maxUsage := int64(0)
	minUsage := int64(-1)

	for _, count := range r.usageCount {
		totalUsage += count
		if count > maxUsage {
			maxUsage = count
		}
		if minUsage == -1 || count < minUsage {
			minUsage = count
		}
	}

	if minUsage == -1 {
		minUsage = 0
	}

	return map[string]interface{}{
		"strategy":        r.strategy,
		"rotate_after":    r.rotateAfter,
		"total_rotations": totalUsage,
		"max_usage":       maxUsage,
		"min_usage":       minUsage,
		"sticky_sessions": len(r.stickySession),
	}
}

// roundRobin returns proxies in order
func (r *Rotator) roundRobin(proxies []*Proxy) *Proxy {
	if len(proxies) == 0 {
		return nil
	}

	index := atomic.AddUint64(&r.currentIndex, 1) - 1
	return proxies[index%uint64(len(proxies))]
}

// random returns a random proxy
func (r *Rotator) random(proxies []*Proxy) *Proxy {
	if len(proxies) == 0 {
		return nil
	}

	return proxies[r.rng.Intn(len(proxies))]
}

// leastUsed returns the least used proxy
func (r *Rotator) leastUsed(proxies []*Proxy) *Proxy {
	if len(proxies) == 0 {
		return nil
	}

	var leastUsedProxy *Proxy
	minUsage := int64(-1)

	for _, proxy := range proxies {
		usage := r.usageCount[proxy.ID]
		if minUsage == -1 || usage < minUsage {
			minUsage = usage
			leastUsedProxy = proxy
		}
	}

	return leastUsedProxy
}

// leastLatency returns the proxy with lowest latency
func (r *Rotator) leastLatency(proxies []*Proxy) *Proxy {
	if len(proxies) == 0 {
		return nil
	}

	var bestProxy *Proxy
	minLatency := time.Duration(-1)

	for _, proxy := range proxies {
		if proxy.Latency > 0 {
			if minLatency == -1 || proxy.Latency < minLatency {
				minLatency = proxy.Latency
				bestProxy = proxy
			}
		}
	}

	// If no proxy has latency data, fall back to random
	if bestProxy == nil {
		return r.random(proxies)
	}

	return bestProxy
}

// weighted returns a proxy based on weighted random selection
// Weight is based on success rate and latency
func (r *Rotator) weighted(proxies []*Proxy) *Proxy {
	if len(proxies) == 0 {
		return nil
	}

	// Calculate weights
	weights := make([]float64, len(proxies))
	totalWeight := 0.0

	for i, proxy := range proxies {
		weight := 1.0

		// Factor in success rate (higher is better)
		successRate := proxy.SuccessRate()
		if successRate > 0 {
			weight *= (successRate / 100.0) + 0.5 // 0.5 to 1.5
		}

		// Factor in latency (lower is better)
		if proxy.Latency > 0 {
			latencyFactor := 1.0 / (float64(proxy.Latency.Milliseconds())/1000.0 + 1)
			weight *= latencyFactor + 0.5
		}

		// Factor in usage (lower is better for distribution)
		usage := r.usageCount[proxy.ID]
		if usage > 0 {
			usageFactor := 1.0 / (float64(usage)/100.0 + 1)
			weight *= usageFactor + 0.5
		}

		weights[i] = weight
		totalWeight += weight
	}

	// Normalize weights and select
	if totalWeight == 0 {
		return r.random(proxies)
	}

	pick := r.rng.Float64() * totalWeight
	cumulative := 0.0

	for i, weight := range weights {
		cumulative += weight
		if pick <= cumulative {
			return proxies[i]
		}
	}

	return proxies[len(proxies)-1]
}

// Exclude returns a proxy excluding specific IDs
func (r *Rotator) Exclude(excludeIDs []string) *Proxy {
	r.mu.Lock()
	defer r.mu.Unlock()

	proxies := r.manager.GetAlive()
	if len(proxies) == 0 {
		return nil
	}

	// Filter out excluded proxies
	excludeMap := make(map[string]bool)
	for _, id := range excludeIDs {
		excludeMap[id] = true
	}

	filtered := make([]*Proxy, 0, len(proxies))
	for _, proxy := range proxies {
		if !excludeMap[proxy.ID] {
			filtered = append(filtered, proxy)
		}
	}

	if len(filtered) == 0 {
		return nil
	}

	var proxy *Proxy

	switch r.strategy {
	case StrategyRoundRobin:
		proxy = r.roundRobin(filtered)
	case StrategyRandom:
		proxy = r.random(filtered)
	case StrategyLeastUsed:
		proxy = r.leastUsed(filtered)
	case StrategyLeastLatency:
		proxy = r.leastLatency(filtered)
	case StrategyWeighted:
		proxy = r.weighted(filtered)
	default:
		proxy = r.roundRobin(filtered)
	}

	if proxy != nil {
		r.usageCount[proxy.ID]++
		r.manager.RecordUsage(proxy.ID)
	}

	return proxy
}

// GetUsageCount returns usage count for a proxy
func (r *Rotator) GetUsageCount(proxyID string) int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()

	return r.usageCount[proxyID]
}

// ResetUsageCount resets all usage counts
func (r *Rotator) ResetUsageCount() {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.usageCount = make(map[string]int64)
}
