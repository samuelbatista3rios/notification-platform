

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  service: string;
  correlationId?: string;
  [key: string]: unknown;
}

class Logger {
  private readonly service: string;
  private correlationId?: string;

  constructor(service: string) {
    this.service = service;
  }

  withCorrelationId(correlationId: string): this {
    this.correlationId = correlationId;
    return this;
  }

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      service: this.service,
      ...(this.correlationId ? { correlationId: this.correlationId } : {}),
      ...extra,
    };
    // Em Lambda, console.log vai direto para CloudWatch Logs
    console.log(JSON.stringify(entry));
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    if (process.env.LOG_LEVEL === 'DEBUG') this.log('DEBUG', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log('INFO', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log('WARN', message, extra);
  }

  error(message: string, error?: unknown, extra?: Record<string, unknown>): void {
    const errorDetails =
      error instanceof Error
        ? { errorMessage: error.message, errorStack: error.stack }
        : { errorRaw: error };
    this.log('ERROR', message, { ...errorDetails, ...extra });
  }
}

export const createLogger = (service: string): Logger => new Logger(service);
