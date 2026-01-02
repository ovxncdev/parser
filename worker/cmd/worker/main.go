package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"
)

// Version info
var (
	Version   = "1.0.0"
	BuildTime = "unknown"
)

// Message types for IPC protocol
type MessageType string

const (
	MsgTypeInit     MessageType = "init"
	MsgTypeTask     MessageType = "task"
	MsgTypeResult   MessageType = "result"
	MsgTypeStatus   MessageType = "status"
	MsgTypeError    MessageType = "error"
	MsgTypeShutdown MessageType = "shutdown"
)

// IPCMessage is the base message structure for communication with CLI
type IPCMessage struct {
	Type      MessageType    `json:"type"`
	Timestamp int64          `json:"ts"`
	Data      map[string]any `json:"data,omitempty"`
}

// Config holds worker configuration
type Config struct {
	Workers       int           `json:"workers"`
	Timeout       time.Duration `json:"timeout"`
	RetryAttempts int           `json:"retry_attempts"`
	RetryDelay    time.Duration `json:"retry_delay"`
	RateLimit     time.Duration `json:"rate_limit"`
}

func main() {
	// Setup logging
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	// Check if running in IPC mode (stdin has data) or standalone
	stat, _ := os.Stdin.Stat()
	if (stat.Mode() & os.ModeCharDevice) == 0 {
		// IPC mode - communicate with TypeScript CLI
		runIPCMode()
	} else {
		// Standalone mode - for testing
		runStandaloneMode()
	}
}

func runIPCMode() {
	log.Println("Worker starting in IPC mode")

	scanner := bufio.NewScanner(os.Stdin)
	// Increase buffer size for large messages
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	// Send ready message
	sendMessage(IPCMessage{
		Type:      MsgTypeStatus,
		Timestamp: time.Now().UnixMilli(),
		Data: map[string]any{
			"status":  "ready",
			"version": Version,
		},
	})

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var msg IPCMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Printf("Failed to parse message: %v", err)
			continue
		}

		handleMessage(msg)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("Scanner error: %v", err)
	}
}

func handleMessage(msg IPCMessage) {
	switch msg.Type {
	case MsgTypeInit:
		handleInit(msg)
	case MsgTypeTask:
		handleTask(msg)
	case MsgTypeShutdown:
		handleShutdown(msg)
	default:
		log.Printf("Unknown message type: %s", msg.Type)
	}
}

func handleInit(msg IPCMessage) {
	log.Printf("Initializing worker with config: %v", msg.Data)
	
	// TODO: Initialize proxy pool, worker pool, etc.
	
	sendMessage(IPCMessage{
		Type:      MsgTypeStatus,
		Timestamp: time.Now().UnixMilli(),
		Data: map[string]any{
			"status": "initialized",
		},
	})
}

func handleTask(msg IPCMessage) {
	// TODO: Process dork task
	dork, _ := msg.Data["dork"].(string)
	taskID, _ := msg.Data["task_id"].(string)
	
	log.Printf("Processing task %s: %s", taskID, dork)
	
	// Placeholder - will be implemented in next steps
	sendMessage(IPCMessage{
		Type:      MsgTypeResult,
		Timestamp: time.Now().UnixMilli(),
		Data: map[string]any{
			"task_id": taskID,
			"dork":    dork,
			"urls":    []string{},
			"status":  "completed",
		},
	})
}

func handleShutdown(msg IPCMessage) {
	log.Println("Shutting down worker")
	sendMessage(IPCMessage{
		Type:      MsgTypeStatus,
		Timestamp: time.Now().UnixMilli(),
		Data: map[string]any{
			"status": "shutdown",
		},
	})
	os.Exit(0)
}

func sendMessage(msg IPCMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal message: %v", err)
		return
	}
	fmt.Println(string(data))
}

func runStandaloneMode() {
	fmt.Println("╔═══════════════════════════════════════════════════════════════════╗")
	fmt.Println("║     ██████╗  ██████╗ ██████╗ ██╗  ██╗███████╗██████╗              ║")
	fmt.Println("║     ██╔══██╗██╔═══██╗██╔══██╗██║ ██╔╝██╔════╝██╔══██╗             ║")
	fmt.Println("║     ██║  ██║██║   ██║██████╔╝█████╔╝ █████╗  ██████╔╝             ║")
	fmt.Println("║     ██║  ██║██║   ██║██╔══██╗██╔═██╗ ██╔══╝  ██╔══██╗             ║")
	fmt.Println("║     ██████╔╝╚██████╔╝██║  ██║██║  ██╗███████╗██║  ██║             ║")
	fmt.Println("║     ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝             ║")
	fmt.Println("║                                                                   ║")
	fmt.Println("║                  Google Dork Parser v" + Version + "                        ║")
	fmt.Println("║                       Worker Engine                               ║")
	fmt.Println("║                                                                   ║")
	fmt.Println("╚═══════════════════════════════════════════════════════════════════╝")
	fmt.Println()
	fmt.Println("This is the Go worker engine. Run via the CLI for full functionality.")
	fmt.Println()
	fmt.Println("Usage: dorker [options]")
	fmt.Println("  --dorks    Path to dorks file")
	fmt.Println("  --proxies  Path to proxies file")
	fmt.Println("  --output   Output directory")
	fmt.Println()
}
