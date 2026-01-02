import { createWriteStream, mkdirSync, existsSync, type WriteStream } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerConfig {
  level: LogLevel;
  console: boolean;
  file: boolean;
  directory: string;
  prefix: string;
  json: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

export class Logger {
  private config: LoggerConfig;
  private stream: WriteStream | null = null;
  private buffer: string[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly BUFFER_SIZE = 100;
  private readonly FLUSH_INTERVAL_MS = 5000;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: 'info',
      console: true,
      file: true,
      directory: './logs',
      prefix: 'dorker',
      json: false,
      ...config,
    };

    if (this.config.file) {
      this.initFileLogging();
    }
  }

  private initFileLogging(): void {
    if (!existsSync(this.config.directory)) {
      mkdirSync(this.config.directory, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${this.config.prefix}_${timestamp}.log`;
    const filepath = path.join(this.config.directory, filename);

    this.stream = createWriteStream(filepath, { flags: 'a' });

    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.FLUSH_INTERVAL_MS);
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  private formatEntry(entry: LogEntry): string {
    if (this.config.json) {
      return JSON.stringify(entry);
    }

    let message = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`;
    if (entry.data) {
      message += ` ${JSON.stringify(entry.data)}`;
    }
    return message;
  }

  private formatConsole(entry: LogEntry): string {
    const color = LOG_COLORS[entry.level];
    const time = entry.timestamp.split('T')[1]?.split('.')[0] || entry.timestamp;
    let message = `${color}[${time}]${RESET} ${entry.message}`;
    if (entry.data && Object.keys(entry.data).length > 0) {
      message += ` ${color}${JSON.stringify(entry.data)}${RESET}`;
    }
    return message;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };

    if (this.config.console) {
      console.log(this.formatConsole(entry));
    }

    if (this.config.file && this.stream) {
      this.buffer.push(this.formatEntry(entry));
      if (this.buffer.length >= this.BUFFER_SIZE) {
        this.flush();
      }
    }
  }

  private flush(): void {
    if (this.buffer.length === 0 || !this.stream) return;

    const content = this.buffer.join('\n') + '\n';
    this.stream.write(content);
    this.buffer = [];
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  task(dork: string, status: 'start' | 'success' | 'fail', data?: Record<string, unknown>): void {
    const message = `Task ${status}: ${dork.substring(0, 50)}`;
    if (status === 'fail') {
      this.warn(message, data);
    } else {
      this.debug(message, data);
    }
  }

  proxy(proxyId: string, event: string, data?: Record<string, unknown>): void {
    this.debug(`Proxy [${proxyId}]: ${event}`, data);
  }

  result(dork: string, urlCount: number, duration: number): void {
    this.info(`Result: ${urlCount} URLs in ${duration}ms`, { dork: dork.substring(0, 50) });
  }

  stats(stats: Record<string, unknown>): void {
    this.info('Stats update', stats);
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  enableConsole(enabled: boolean): void {
    this.config.console = enabled;
  }

  enableFile(enabled: boolean): void {
    this.config.file = enabled;
    if (enabled && !this.stream) {
      this.initFileLogging();
    }
  }

  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    this.flush();

    if (this.stream) {
      await new Promise<void>((resolve, reject) => {
        this.stream!.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.stream = null;
    }
  }
}

let defaultLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = new Logger();
  }
  return defaultLogger;
}

export function createLogger(config: Partial<LoggerConfig> = {}): Logger {
  return new Logger(config);
}

export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger;
}
