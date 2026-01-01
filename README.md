
#  Google Dork Parser

High-performance Google dork parser with hybrid Go/TypeScript architecture. Built for speed, stealth, and scale.

##  Features

- **Blazing Fast**: Go core engine for HTTP scraping (10-40x faster than Node.js)
- **Stealth Mode**: Advanced fingerprinting, timing randomization, header rotation
- **Smart Proxy Rotation**: 5 rotation strategies with health checking and quarantine
- **Browser Fallback**: Playwright integration for CAPTCHA bypass
- **Anti-Public Filter**: Local SQLite database tracks scraped domains
- **Rich CLI**: Progress bars, live stats, activity logging
- **Resume Capability**: Save progress and resume interrupted sessions
- **Multiple Outputs**: TXT, JSON, CSV, SQLite formats

##  Performance

| Metric | Target |
|--------|--------|
| 400k dorks + 2k proxies | 4-6 hours |
| Requests per proxy/hour | 10-30 (safe rate) |
| Memory usage | <100MB (Go engine) |
| Concurrent workers | 100-200 |

##  Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TypeScript CLI                           │
│  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌───────────────┐  │
│  │   UI    │  │ Scheduler│  │ Filter │  │ Output Writer │  │
│  └────┬────┘  └────┬─────┘  └───┬────┘  └───────┬───────┘  │
│       │            │            │               │           │
│       └────────────┼────────────┼───────────────┘           │
│                    │            │                           │
│                    ▼            ▼                           │
│              JSON Protocol (stdin/stdout)                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌────────────────────┴────────────────────────────────────────┐
│                      Go Core Engine                         │
│  ┌─────────┐  ┌───────────┐  ┌─────────┐  ┌─────────────┐  │
│  │ Stealth │  │   Proxy   │  │  Parser │  │   Google    │  │
│  │ Headers │  │  Manager  │  │ Extract │  │   Engine    │  │
│  │ Timing  │  │  Rotator  │  │  Clean  │  │   Search    │  │
│  └─────────┘  └───────────┘  └─────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

##  Quick Start

### Prerequisites

- Node.js 18+
- Go 1.21+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/google-dork-parser.git
cd google-dork-parser

# Install dependencies
npm install

# Build Go engine
npm run build:go

# Build TypeScript
npm run build

# Or build everything
npm run build:all
```

### Usage

```bash
# Basic usage
npx dorker run -d dorks.txt -p proxies.txt -o ./output

# With options
npx dorker run \
  -d dorks.txt \
  -p proxies.txt \
  -o ./output \
  -t 100 \          # 100 workers
  --pages 5 \       # 5 pages per dork
  -f txt,json       # Output formats

# Validate files
npx dorker validate -d dorks.txt -p proxies.txt

# Check proxies
npx dorker check-proxies -p proxies.txt

# Estimate time
npx dorker estimate -d dorks.txt -p proxies.txt

# Resume previous session
npx dorker resume
```

##  File Structure

```
google-dork-parser/
├── core/                          # Go engine
│   ├── cmd/gorker/main.go         # Entry point
│   └── internal/
│       ├── protocol/              # JSON messaging
│       ├── stealth/               # Anti-detection
│       ├── proxy/                 # Proxy management
│       ├── parser/                # URL extraction
│       └── engine/                # Search engines
├── src/                           # TypeScript
│   ├── orchestrator/              # Go process management
│   ├── browser/                   # Playwright fallback
│   ├── filter/                    # URL filtering
│   ├── output/                    # File writers
│   ├── cli/                       # Terminal UI
│   └── utils/                     # Helpers
├── config/                        # Configuration files
├── input/                         # Input files (dorks, proxies)
├── output/                        # Results
└── bin/                           # Compiled binaries
```

##  Configuration

Edit `config/settings.json`:

```json
{
  "engine": {
    "workers": 100,
    "pagesPerDork": 5,
    "timeout": 30000
  },
  "proxy": {
    "rotateAfter": 1,
    "rotationStrategy": "round_robin",
    "healthCheckOnStart": true
  },
  "stealth": {
    "profile": "normal",
    "delayMin": 1000,
    "delayMax": 3000
  },
  "filter": {
    "antiPublic": true,
    "removeDuplicates": true,
    "urlParamsOnly": false
  }
}
```

##  Input Formats

### Dorks File (dorks.txt)

```
inurl:product.php?id=
inurl:page.php?id=
site:example.com filetype:sql
intitle:"index of" password
```

### Proxies File (proxies.txt)

```
# Supported formats:
192.168.1.1:8080
192.168.1.1:8080:user:pass
user:pass@192.168.1.1:8080
http://192.168.1.1:8080
socks5://user:pass@192.168.1.1:1080
```

##  Output

Results are saved in timestamped folders:

```
output/
└── 2024-01-15_14-30-00/
    ├── results.txt          # URLs (one per line)
    ├── results.json         # URLs with metadata
    ├── results.csv          # Spreadsheet format
    ├── domains.txt          # Unique domains
    └── stats.json           # Run statistics
```

##  Stealth Features

- **Header Randomization**: Browser-specific headers, proper ordering
- **Fingerprint Spoofing**: Screen size, WebGL, timezone, etc.
- **Timing Profiles**: Gaussian delays, burst control, session limits
- **Cookie Generation**: Realistic Google cookies
- **User Agent Rotation**: Chrome, Firefox, Edge, Safari

##  Proxy Features

- **5 Rotation Strategies**: Round-robin, random, least-used, least-latency, weighted
- **Health Checking**: TCP and HTTP verification
- **Quarantine System**: Temporary bans for failed proxies
- **Protocol Support**: HTTP, HTTPS, SOCKS4, SOCKS5
- **Dynamic Management**: Add/remove proxies at runtime

##  Filtering

- **Domain Extraction**: Full domain and top-level domain
- **Deduplication**: Bloom filter for memory efficiency
- **Anti-Public**: Filter out common sites (Google, Facebook, etc.)
- **TLD Filtering**: Whitelist/blacklist specific TLDs
- **Keyword Filtering**: Include/exclude by URL keywords
- **Local History**: SQLite tracks previously scraped domains

##  CLI Commands

| Command | Description |
|---------|-------------|
| `run` | Start parsing dorks |
| `validate` | Validate dorks/proxies files |
| `check-proxies` | Test proxy connectivity |
| `estimate` | Estimate completion time |
| `resume` | Resume previous session |

##  Live Statistics

```
📈 Live Statistics
──────────────────────────────────────────────────
  Progress:    15,234/400,000 dorks (3.8%)
  URLs:        45,678 total, 38,901 unique
  Speed:       127.4 req/min, 304.2 urls/min
  Success:     94.2%
  Workers:     98/100
  Blocks:      12 CAPTCHA, 45 rate limits
  Time:        1h 23m elapsed, 4h 12m remaining
──────────────────────────────────────────────────
```

## ⚠️ Legal Disclaimer

This tool is for educational and authorized security testing purposes only. Users are responsible for complying with applicable laws and website terms of service. The authors are not responsible for misuse.

##  License

MIT License - see [LICENSE](LICENSE) for details.

##  Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

##  Acknowledgments

- [Playwright](https://playwright.dev/) - Browser automation
- [fasthttp](https://github.com/valyala/fasthttp) - Fast HTTP for Go
- [Chalk](https://github.com/chalk/chalk) - Terminal styling
- [Commander](https://github.com/tj/commander.js) - CLI framework
