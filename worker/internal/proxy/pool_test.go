package proxy

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestNewPool(t *testing.T) {
	config := DefaultPoolConfig()
	pool := NewPool(config)

	if pool == nil {
		t.Fatal("NewPool returned nil")
	}

	stats := pool.Stats()
	if stats.Total != 0 {
		t.Errorf("new pool total = %d, want 0", stats.Total)
	}
}

func TestPoolAddProxy(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	proxy := &Proxy{
		ID:   "test_1",
		Host: "192.168.1.1",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}

	err := pool.AddProxy(proxy)
	if err != nil {
		t.Fatalf("AddProxy failed: %v", err)
	}

	stats := pool.Stats()
	if stats.Total != 1 {
		t.Errorf("total = %d, want 1", stats.Total)
	}
	if stats.Alive != 1 {
		t.Errorf("alive = %d, want 1", stats.Alive)
	}

	// Adding duplicate should fail
	err = pool.AddProxy(proxy)
	if err == nil {
		t.Error("adding duplicate proxy should fail")
	}
}

func TestPoolAddProxies(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	proxies := []*Proxy{
		{ID: "test_1", Host: "192.168.1.1", Port: "8080", Type: ProxyTypeHTTP},
		{ID: "test_2", Host: "192.168.1.2", Port: "8080", Type: ProxyTypeHTTP},
		{ID: "test_3", Host: "192.168.1.3", Port: "8080", Type: ProxyTypeHTTP},
	}

	added, errors := pool.AddProxies(proxies)

	if added != 3 {
		t.Errorf("added = %d, want 3", added)
	}
	if len(errors) != 0 {
		t.Errorf("errors = %d, want 0", len(errors))
	}

	stats := pool.Stats()
	if stats.Total != 3 {
		t.Errorf("total = %d, want 3", stats.Total)
	}
}

func TestPoolGet(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	// Empty pool should return error
	_, err := pool.Get()
	if err == nil {
		t.Error("Get on empty pool should return error")
	}

	// Add proxies
	proxies := []*Proxy{
		{ID: "test_1", Host: "192.168.1.1", Port: "8080", Type: ProxyTypeHTTP},
		{ID: "test_2", Host: "192.168.1.2", Port: "8080", Type: ProxyTypeHTTP},
	}
	pool.AddProxies(proxies)

	// Should get a proxy
	proxy, err := pool.Get()
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if proxy == nil {
		t.Fatal("Get returned nil proxy")
	}
}

func TestPoolGetByID(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	proxy := &Proxy{
		ID:   "test_1",
		Host: "192.168.1.1",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}
	pool.AddProxy(proxy)

	// Should find existing proxy
	found, exists := pool.GetByID("test_1")
	if !exists {
		t.Error("GetByID should find existing proxy")
	}
	if found.Host != "192.168.1.1" {
		t.Errorf("found proxy host = %q, want %q", found.Host, "192.168.1.1")
	}

	// Should not find non-existent proxy
	_, exists = pool.GetByID("non_existent")
	if exists {
		t.Error("GetByID should not find non-existent proxy")
	}
}

func TestPoolReportSuccess(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	proxy := &Proxy{
		ID:   "test_1",
		Host: "192.168.1.1",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}
	pool.AddProxy(proxy)

	pool.ReportSuccess("test_1", 100*time.Millisecond)

	found, _ := pool.GetByID("test_1")
	if found.SuccessCount != 1 {
		t.Errorf("success count = %d, want 1", found.SuccessCount)
	}
	if found.TotalRequests != 1 {
		t.Errorf("total requests = %d, want 1", found.TotalRequests)
	}
}

func TestPoolReportFailure(t *testing.T) {
	config := DefaultPoolConfig()
	config.MaxFailures = 3
	pool := NewPool(config)

	proxy := &Proxy{
		ID:   "test_1",
		Host: "192.168.1.1",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}
	pool.AddProxy(proxy)

	// Report failures up to threshold
	pool.ReportFailure("test_1")
	pool.ReportFailure("test_1")

	stats := pool.Stats()
	if stats.Quarantined != 0 {
		t.Errorf("quarantined = %d, want 0 (not yet at threshold)", stats.Quarantined)
	}

	// This failure should trigger quarantine
	pool.ReportFailure("test_1")

	stats = pool.Stats()
	if stats.Quarantined != 1 {
		t.Errorf("quarantined = %d, want 1", stats.Quarantined)
	}
	if stats.Alive != 0 {
		t.Errorf("alive = %d, want 0", stats.Alive)
	}
}

func TestPoolReportCaptcha(t *testing.T) {
	config := DefaultPoolConfig()
	config.CooldownDuration = 100 * time.Millisecond
	pool := NewPool(config)

	proxy := &Proxy{
		ID:   "test_1",
		Host: "192.168.1.1",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}
	pool.AddProxy(proxy)

	pool.ReportCaptcha("test_1")

	found, _ := pool.GetByID("test_1")
	if found.CaptchaCount != 1 {
		t.Errorf("captcha count = %d, want 1", found.CaptchaCount)
	}

	// Proxy should be on cooldown
	if found.IsAvailable() {
		t.Error("proxy should be on cooldown after CAPTCHA")
	}

	// Wait for cooldown
	time.Sleep(150 * time.Millisecond)

	if !found.IsAvailable() {
		t.Error("proxy should be available after cooldown")
	}
}

func TestPoolReportBlock(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	proxy := &Proxy{
		ID:   "test_1",
		Host: "192.168.1.1",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}
	pool.AddProxy(proxy)

	pool.ReportBlock("test_1")

	stats := pool.Stats()
	if stats.Quarantined != 1 {
		t.Errorf("quarantined = %d, want 1", stats.Quarantined)
	}
	if stats.Alive != 0 {
		t.Errorf("alive = %d, want 0", stats.Alive)
	}
}

func TestPoolHealthCheck(t *testing.T) {
	config := DefaultPoolConfig()
	config.QuarantineDuration = 100 * time.Millisecond
	config.HealthCheckInterval = 50 * time.Millisecond
	pool := NewPool(config)

	proxy := &Proxy{
		ID:   "test_1",
		Host: "192.168.1.1",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}
	pool.AddProxy(proxy)

	// Quarantine the proxy
	pool.ReportBlock("test_1")

	stats := pool.Stats()
	if stats.Quarantined != 1 {
		t.Fatalf("quarantined = %d, want 1", stats.Quarantined)
	}

	// Start health check
	pool.StartHealthCheck()
	defer pool.StopHealthCheck()

	// Wait for quarantine to expire and health check to run
	time.Sleep(200 * time.Millisecond)

	stats = pool.Stats()
	if stats.Alive != 1 {
		t.Errorf("alive = %d, want 1 (should be revived)", stats.Alive)
	}
	if stats.Quarantined != 0 {
		t.Errorf("quarantined = %d, want 0", stats.Quarantined)
	}
}

func TestPoolWeightedSelection(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	// Add proxies with different success rates
	goodProxy := &Proxy{
		ID:   "good",
		Host: "192.168.1.1",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}
	badProxy := &Proxy{
		ID:   "bad",
		Host: "192.168.1.2",
		Port: "8080",
		Type: ProxyTypeHTTP,
	}

	pool.AddProxy(goodProxy)
	pool.AddProxy(badProxy)

	// Simulate good proxy having high success rate
	for i := 0; i < 10; i++ {
		pool.ReportSuccess("good", 50*time.Millisecond)
	}

	// Simulate bad proxy having low success rate
	for i := 0; i < 8; i++ {
		pool.ReportFailure("bad")
	}
	for i := 0; i < 2; i++ {
		pool.ReportSuccess("bad", 500*time.Millisecond)
	}

	// Get proxies many times and count
	goodCount := 0
	badCount := 0
	for i := 0; i < 100; i++ {
		p, _ := pool.Get()
		if p.ID == "good" {
			goodCount++
		} else {
			badCount++
		}
	}

	// Good proxy should be selected more often
	if goodCount <= badCount {
		t.Errorf("good proxy selected %d times, bad proxy %d times; good should be selected more often",
			goodCount, badCount)
	}
}

func TestPoolConcurrency(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	// Add proxies
	for i := 0; i < 100; i++ {
		proxy := &Proxy{
			ID:   fmt.Sprintf("proxy_%d", i),
			Host: fmt.Sprintf("192.168.1.%d", i),
			Port: "8080",
			Type: ProxyTypeHTTP,
		}
		pool.AddProxy(proxy)
	}

	// Concurrent access
	var wg sync.WaitGroup
	errors := make(chan error, 1000)

	// Concurrent Gets
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				_, err := pool.Get()
				if err != nil {
					errors <- err
				}
			}
		}()
	}

	// Concurrent Reports
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			proxyID := fmt.Sprintf("proxy_%d", idx%100)
			for j := 0; j < 5; j++ {
				pool.ReportSuccess(proxyID, 100*time.Millisecond)
				pool.ReportFailure(proxyID)
			}
		}(i)
	}

	wg.Wait()
	close(errors)

	// Check for errors
	errorCount := 0
	for err := range errors {
		t.Logf("concurrent error: %v", err)
		errorCount++
	}

	// Some errors are expected if proxies get quarantined
	if errorCount > 50 {
		t.Errorf("too many concurrent errors: %d", errorCount)
	}
}

func TestPoolStats(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	// Add proxies
	for i := 0; i < 10; i++ {
		proxy := &Proxy{
			ID:   fmt.Sprintf("proxy_%d", i),
			Host: fmt.Sprintf("192.168.1.%d", i),
			Port: "8080",
			Type: ProxyTypeHTTP,
		}
		pool.AddProxy(proxy)
	}

	stats := pool.Stats()

	if stats.Total != 10 {
		t.Errorf("total = %d, want 10", stats.Total)
	}
	if stats.Alive != 10 {
		t.Errorf("alive = %d, want 10", stats.Alive)
	}
	if stats.AlivePercentage() != 100 {
		t.Errorf("alive percentage = %v, want 100", stats.AlivePercentage())
	}
}

func TestPoolRecommendedWorkers(t *testing.T) {
	pool := NewPool(DefaultPoolConfig())

	// Empty pool
	if workers := pool.RecommendedWorkers(); workers != 0 {
		t.Errorf("empty pool recommended workers = %d, want 0", workers)
	}

	// Add 50 proxies
	for i := 0; i < 50; i++ {
		proxy := &Proxy{
			ID:   fmt.Sprintf("proxy_%d", i),
			Host: fmt.Sprintf("192.168.1.%d", i),
			Port: "8080",
			Type: ProxyTypeHTTP,
		}
		pool.AddProxy(proxy)
	}

	workers := pool.RecommendedWorkers()
	if workers != 5 {
		t.Errorf("50 proxies recommended workers = %d, want 5", workers)
	}

	// Add more to test cap
	for i := 50; i < 3000; i++ {
		proxy := &Proxy{
			ID:   fmt.Sprintf("proxy_%d", i),
			Host: fmt.Sprintf("10.0.%d.%d", i/256, i%256),
			Port: "8080",
			Type: ProxyTypeHTTP,
		}
		pool.AddProxy(proxy)
	}

	workers = pool.RecommendedWorkers()
	if workers != 200 {
		t.Errorf("3000 proxies recommended workers = %d, want 200 (max cap)", workers)
	}
}

func TestPoolGetAllMethods(t *testing.T) {
	config := DefaultPoolConfig()
	config.MaxFailures = 1
	pool := NewPool(config)

	// Add proxies
	proxy1 := &Proxy{ID: "alive_1", Host: "192.168.1.1", Port: "8080", Type: ProxyTypeHTTP}
	proxy2 := &Proxy{ID: "to_quarantine", Host: "192.168.1.2", Port: "8080", Type: ProxyTypeHTTP}
	pool.AddProxy(proxy1)
	pool.AddProxy(proxy2)

	// Quarantine one
	pool.ReportFailure("to_quarantine")

	alive := pool.GetAllAlive()
	if len(alive) != 1 {
		t.Errorf("alive count = %d, want 1", len(alive))
	}

	quarantined := pool.GetAllQuarantined()
	if len(quarantined) != 1 {
		t.Errorf("quarantined count = %d, want 1", len(quarantined))
	}

	dead := pool.GetAllDead()
	if len(dead) != 0 {
		t.Errorf("dead count = %d, want 0", len(dead))
	}
}
