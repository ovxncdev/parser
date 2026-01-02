// Message types for IPC protocol
export type MessageType =
  | 'init'
  | 'task'
  | 'task_batch'
  | 'pause'
  | 'resume'
  | 'shutdown'
  | 'get_stats'
  | 'status'
  | 'result'
  | 'stats'
  | 'error'
  | 'log'
  | 'progress'
  | 'proxy_info';

// Base IPC message
export interface IPCMessage {
  type: MessageType;
  ts: number;
  id?: string;
  data?: Record<string, unknown>;
}

// Init configuration
export interface InitConfig {
  workers: number;
  timeout: number;
  base_delay: number;
  min_delay: number;
  max_delay: number;
  max_retries: number;
  results_per_page: number;
  proxies?: string[];
  proxy_file?: string;
}

// Task data
export interface TaskData {
  task_id: string;
  dork: string;
  page?: number;
}

// Result data
export interface ResultData {
  task_id: string;
  dork: string;
  urls: string[];
  status: ResultStatus;
  error?: string;
  proxy_id: string;
  duration_ms: number;
}

// Result status
export type ResultStatus =
  | 'success'
  | 'no_results'
  | 'captcha'
  | 'blocked'
  | 'error'
  | 'retry';

// Stats data
export interface StatsData {
  tasks_total: number;
  tasks_completed: number;
  tasks_failed: number;
  tasks_pending: number;
  urls_found: number;
  captcha_count: number;
  block_count: number;
  proxies_alive: number;
  proxies_dead: number;
  requests_per_sec: number;
  elapsed_ms: number;
  eta_ms: number;
}

// Progress data
export interface ProgressData {
  current: number;
  total: number;
  percentage: number;
}

// Proxy info
export interface ProxyInfo {
  alive: number;
  dead: number;
  quarantined: number;
  total: number;
}

// Proxy formats
export interface Proxy {
  id: string;
  host: string;
  port: string;
  username?: string;
  password?: string;
  type: ProxyType;
  status: ProxyStatus;
}

export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5';
export type ProxyStatus = 'unknown' | 'alive' | 'dead' | 'slow' | 'quarantined';

// CLI configuration
export interface CLIConfig {
  dorksFile: string;
  proxiesFile: string;
  outputDir: string;
  workers: number;
  timeout: number;
  baseDelay: number;
  minDelay: number;
  maxDelay: number;
  maxRetries: number;
  resultsPerPage: number;
  filters: FilterConfig;
}

// Filter configuration
export interface FilterConfig {
  cleanTopDomains: boolean;
  urlParametersOnly: boolean;
  noRedirectUrls: boolean;
  removeDuplicateDomains: boolean;
  antiPublic: boolean;
  keepUnfiltered: boolean;
  antiPublicFile?: string;
}

// Output options
export interface OutputConfig {
  format: OutputFormat;
  directory: string;
  prefix: string;
  splitByDork: boolean;
  includeMetadata: boolean;
}

export type OutputFormat = 'txt' | 'json' | 'csv' | 'jsonl';

// Search result
export interface SearchResult {
  url: string;
  title?: string;
  description?: string;
  position?: number;
  dork: string;
  timestamp: number;
}

// Dork entry
export interface DorkEntry {
  id: string;
  query: string;
  status: DorkStatus;
  results: number;
  retries: number;
  error?: string;
  startTime?: number;
  endTime?: number;
}

export type DorkStatus = 'pending' | 'processing' | 'completed' | 'failed';

// Activity log entry
export interface ActivityEntry {
  timestamp: number;
  type: 'success' | 'error' | 'warning' | 'info';
  dork: string;
  message: string;
  urls?: number;
}

// UI state
export interface UIState {
  isRunning: boolean;
  isPaused: boolean;
  stats: StatsData;
  progress: ProgressData;
  proxyInfo: ProxyInfo;
  recentActivity: ActivityEntry[];
  throughputHistory: number[];
}

// Default configurations
export const DEFAULT_CONFIG: CLIConfig = {
  dorksFile: '',
  proxiesFile: '',
  outputDir: './output',
  workers: 10,
  timeout: 30000,
  baseDelay: 8000,
  minDelay: 3000,
  maxDelay: 15000,
  maxRetries: 3,
  resultsPerPage: 100,
  filters: {
    cleanTopDomains: true,
    urlParametersOnly: false,
    noRedirectUrls: true,
    removeDuplicateDomains: true,
    antiPublic: true,
    keepUnfiltered: true,
  },
};

export const DEFAULT_STATS: StatsData = {
  tasks_total: 0,
  tasks_completed: 0,
  tasks_failed: 0,
  tasks_pending: 0,
  urls_found: 0,
  captcha_count: 0,
  block_count: 0,
  proxies_alive: 0,
  proxies_dead: 0,
  requests_per_sec: 0,
  elapsed_ms: 0,
  eta_ms: 0,
};

export const DEFAULT_PROGRESS: ProgressData = {
  current: 0,
  total: 0,
  percentage: 0,
};

export const DEFAULT_PROXY_INFO: ProxyInfo = {
  alive: 0,
  dead: 0,
  quarantined: 0,
  total: 0,
};
