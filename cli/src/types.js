export const DEFAULT_CONFIG = {
  workers: 10,
  timeout: 30000,
  baseDelay: 8000,
  minDelay: 3000,
  maxDelay: 15000,
  maxRetries: 3,
  resultsPerPage: 100,
};

export const DEFAULT_STATS = {
  tasks_total: 0,
  tasks_completed: 0,
  tasks_failed: 0,
  tasks_pending: 0,
  urls_found: 0,
  captcha_count: 0,
  block_count: 0,
  error_count: 0,
  requests_per_sec: 0,
  avg_response_time: 0,
  elapsed_ms: 0,
  eta_ms: 0,
};

export const DEFAULT_PROGRESS = {
  current: 0,
  total: 0,
  percentage: 0,
};

export const DEFAULT_PROXY_INFO = {
  alive: 0,
  dead: 0,
  quarantined: 0,
  total: 0,
};
