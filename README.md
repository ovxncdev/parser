# Dorker - High-Performance Google Dork Parser

A blazing-fast Google dork parser capable of processing 400K+ dorks with 2K proxies in under 4 hours.

## Features

- **Hybrid Architecture**: Go worker for HTTP performance, TypeScript CLI for UI/orchestration
- **High Concurrency**: Process thousands of dorks simultaneously
- **Smart Proxy Management**: Automatic rotation, health checking, and quarantine
- **Stealth Mode**: Browser fingerprint rotation, JA3 spoofing, human-like delays
- **Advanced Filtering**: Anti-public domains, deduplication, URL parameter filtering
- **Real-time Dashboard**: Terminal UI with live statistics and progress
- **Checkpoint/Resume**: Never lose progress on long-running jobs
- **Multiple Output Formats**: TXT, JSON, CSV, JSONL

## Quick Start

### Prerequisites

- Go 1.22+
- Node.js 20+
- Make (optional)

### Installation
```bash
# Clone repository
git clone https://github.com/yourusername/dorker.git
cd dorker

# Build everything
make build

# Or build separately
cd worker && go build -o ../bin/worker ./cmd/worker
cd ../cli && npm install && npm run build
```

### Basic Usage
```bash
# Run with dorks and proxies files
./bin/worker --standalone --dorks input/dorks.txt --proxies input/proxies.txt

# Or use the CLI with full UI
cd cli && node dist/index.js run -d ../input/dorks.txt -p ../input/proxies.txt
```

## Proxy Formats

Dorker supports multiple proxy formats:
```
# Simple
192.168.1.1:8080

# With authentication
192.168.1.1:8080:username:password
username:password@192.168.1.1:8080

# With protocol
http://192.168.1.1:8080
https://192.168.1.1:8080
socks4://192.168.1.1:1080
socks5://192.168.1.1:1080

# SOCKS with auth
socks5://username:password@192.168.1.1:1080
```

## Dork File Format

One dork per line. Lines starting with `#` are comments.
```
# Example dorks file
inurl:admin
inurl:login filetype:php
intitle:"index of" password
site:example.com filetype:pdf
```

## CLI Commands

### Run Command
```bash
dorker run [options]

Options:
  -d, --dorks <file>         Path to dorks file (required)
  -p, --proxies <file>       Path to proxies file (required)
  -o, --output <dir>         Output directory (default: ./output)
  -w, --workers <number>     Number of concurrent workers (default: 10)
  --timeout <ms>             Request timeout in ms (default: 30000)
  --base-delay <ms>          Base delay between requests (default: 8000)
  --min-delay <ms>           Minimum delay (default: 3000)
  --max-delay <ms>           Maximum delay (default: 15000)
  --max-retries <number>     Max retries per dork (default: 3)
  --results-per-page <n>     Results per search page (default: 100)
  --no-anti-public           Disable anti-public domain filter
  --no-dedup                 Disable URL deduplication
  --no-domain-dedup          Disable domain deduplication
  --params-only              Keep only URLs with parameters
  --no-ui                    Run without terminal UI
  --format <type>            Output format: txt, json, csv, jsonl
  --split-by-dork            Create separate output files per dork
```

### Validate Command
```bash
dorker validate -d dorks.txt -p proxies.txt
```

### Filter Command
```bash
dorker filter -i urls.txt -o filtered.txt --no-anti-public
```

## Configuration File

Create `dorker.yml` in your project directory:
```yaml
# Concurrency settings
workers: 10
timeout: 30000
baseDelay: 8000
minDelay: 3000
maxDelay: 15000
maxRetries: 3
resultsPerPage: 100

# Filter settings
filters:
  antiPublic: true
  removeDuplicateDomains: true
  noRedirectUrls: true
  urlParametersOnly: false
  cleanTopDomains: false
  keepUnfiltered: true

# Output settings
output:
  format: txt
  directory: ./output
  prefix: dorker
  splitByDork: false
```

## Environment Variables
```bash
DORKER_WORKERS=10
DORKER_TIMEOUT=30000
DORKER_BASE_DELAY=8000
DORKER_MIN_DELAY=3000
DORKER_MAX_DELAY=15000
DORKER_MAX_RETRIES=3
DORKER_OUTPUT_DIR=./output
```

## Docker Usage

### Build Image
```bash
docker build -t dorker:latest .
```

### Run Container
```bash
docker run -it --rm \
  -v $(pwd)/input:/app/input:ro \
  -v $(pwd)/output:/app/output \
  dorker:latest \
  node /app/cli/dist/index.js run \
  -d /app/input/dorks.txt \
  -p /app/input/proxies.txt \
  --no-ui
```

### Docker Compose
```bash
# Start with default help
docker-compose up dorker

# Run with specific files
docker-compose --profile run up dorker-run
```

## Output Files

After running, the output directory will contain:
```
output/
├── dorker_results_2024-01-15.txt    # Main results
├── dorker_unfiltered_2024-01-15.txt # Unfiltered results
├── dorker_domains_2024-01-15.txt    # Unique domains
├── dorker_failed_dorks_2024-01-15.txt # Failed dorks for retry
├── dorker_summary_2024-01-15.json   # Run summary/statistics
└── .checkpoint_session_xxx.json     # Checkpoint file
```

## Performance Tuning

### Optimal Settings for 2K Proxies
```yaml
workers: 200              # 1 worker per 10 proxies
timeout: 30000            # 30 second timeout
baseDelay: 5000           # 5 second base delay
minDelay: 2000            # 2 second minimum
maxDelay: 10000           # 10 second maximum
maxRetries: 3             # 3 retries per dork
```

### Expected Performance

| Proxies | Workers | Delay | Throughput | 400K Dorks |
|---------|---------|-------|------------|------------|
| 500     | 50      | 8s    | ~6/s       | ~18 hours  |
| 1000    | 100     | 8s    | ~12/s      | ~9 hours   |
| 2000    | 200     | 5s    | ~40/s      | ~3 hours   |
| 2000    | 200     | 3s    | ~65/s      | ~1.7 hours |

## Anti-Detection Features

### Fingerprint Rotation
- 8+ browser fingerprints (Chrome, Firefox, Safari, Edge)
- Automatic rotation every 100 requests
- JA3 TLS fingerprint spoofing
- Realistic Sec-Ch-* headers

### Timing Intelligence
- Gaussian delay distribution
- Configurable jitter (±30%)
- Human-like request patterns

### Proxy Intelligence
- Automatic health checking
- Success rate tracking
- CAPTCHA detection and cooldown
- Block detection and quarantine

## Troubleshooting

### High CAPTCHA Rate
- Increase `baseDelay` to 10000+
- Reduce `workers` count
- Use higher quality proxies

### Many Blocked Proxies
- Check proxy quality
- Increase `maxDelay`
- Enable proxy rotation

### Slow Performance
- Increase `workers`
- Decrease delays (carefully)
- Use more proxies

### Out of Memory
- Reduce `workers`
- Enable `splitByDork` for large runs
- Use `--no-ui` mode

## Project Structure
```
dorker/
├── worker/                 # Go worker engine
│   ├── cmd/worker/         # Entry point
│   └── internal/
│       ├── proxy/          # Proxy management
│       ├── stealth/        # Fingerprint rotation
│       ├── engine/         # Search engine
│       ├── worker/         # Task processing
│       └── protocol/       # IPC protocol
├── cli/                    # TypeScript CLI
│   └── src/
│       ├── index.ts        # Entry point
│       ├── ipc.ts          # Worker communication
│       ├── filters.ts      # URL filtering
│       ├── output.ts       # Output writing
│       ├── ui.ts           # Terminal UI
│       ├── config.ts       # Configuration
│       ├── checkpoint.ts   # Resume support
│       └── logger.ts       # Logging
├── input/                  # Sample input files
├── scripts/                # Utility scripts
├── Makefile                # Build automation
├── Dockerfile              # Container build
└── docker-compose.yml      # Container orchestration
```

## License

MIT License - see LICENSE file for details.

## Disclaimer

This tool is for educational and authorized security testing purposes only. Always obtain proper authorization before scanning any systems. The authors are not responsible for any misuse of this tool.
