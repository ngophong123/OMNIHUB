import { accessLogPath } from '../deployment-security';
import { getLogContext, type LogCategory } from './request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export const REDACTED_VALUE = '[REDACTED]';

/** Standard envelope keys preserved regardless of optional caller allowlists. */
export const STANDARD_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'timestamp',
  'level',
  'category',
  'service',
  'code',
  'correlationId',
  'component',
  'tenantId',
  'storeId',
  'userId',
  'jobName',
  'batchId',
]);

const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'authorization',
  'credential',
  'privatekey',
  'apikey',
  'signature',
  'hmac',
  'cvv',
  'cardnumber',
  'connectionstring',
  'databaseurl',
  'redisurl',
  'rawbody',
];

const EXACT_SENSITIVE_KEYS = new Set([
  'pass',
  'pan',
  'pin',
  'otp',
  'auth',
  'session',
  'key',
]);

const URL_CREDENTIALS_RE = /((?:postgres(?:ql)?|rediss?|https?):\/\/)([^:@/\s]+):([^@/\s]+)@/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const COOKIE_PAIR_RE = /\b(session|token|refresh_token|access_token|id_token)=([^;\s,]+)/gi;
const HEX64_RE = /\b[a-f0-9]{64}\b/gi;
const HIGH_CONFIDENCE_SECRET_RE = /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{16,})\b/g;
const PEM_HEADER_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g;

export type LogRecord = {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  service: string;
  code: string;
  [key: string]: unknown;
};

export interface LogSink {
  write(level: LogLevel, serialized: string): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export type StructuredLoggerOptions = {
  service: string;
  component?: string;
  level?: LogLevel | (() => LogLevel);
  defaultCategory?: LogCategory;
  allowedFields?: ReadonlySet<string>;
  sink?: LogSink;
  onWriteError?: (error: unknown) => void;
};

/** Resolves a valid LogLevel from environment or defaults safely to 'info'. */
export function resolveLogLevel(raw?: string): LogLevel {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error' || normalized === 'fatal') {
    return normalized;
  }
  return 'info';
}

export function isSensitiveFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return false;
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_FRAGMENTS.some(fragment => normalized.includes(fragment));
}

export function scrubSensitiveString(value: string, fieldName?: string): string {
  const lowerField = fieldName?.toLowerCase();
  if (lowerField === 'path' || lowerField === 'url' || lowerField === 'originalurl') {
    return accessLogPath(value);
  }
  return value
    .replace(URL_CREDENTIALS_RE, `$1${REDACTED_VALUE}:${REDACTED_VALUE}@`)
    .replace(BEARER_RE, `Bearer ${REDACTED_VALUE}`)
    .replace(COOKIE_PAIR_RE, `$1=${REDACTED_VALUE}`)
    .replace(HEX64_RE, REDACTED_VALUE)
    .replace(HIGH_CONFIDENCE_SECRET_RE, REDACTED_VALUE)
    .replace(PEM_HEADER_RE, REDACTED_VALUE);
}

/** Recursively redacts sensitive keys, capability paths, URL credentials, and circular references. */
export function sanitizeLogValue(
  value: unknown,
  fieldName?: string,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (fieldName && isSensitiveFieldName(fieldName)) {
    return REDACTED_VALUE;
  }
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return scrubSensitiveString(value as string, fieldName);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type === 'function' || type === 'symbol') return `[${type}]`;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof Error) {
    return { errorType: value.name };
  }
  if (depth >= 6) {
    return '[MaxDepth]';
  }
  if (typeof value === 'object') {
    const obj = value as object;
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    try {
      if (Array.isArray(value)) {
        return value.map(item => sanitizeLogValue(item, undefined, depth + 1, seen));
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        out[k] = sanitizeLogValue(v, k, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  }
  return String(value);
}

export const defaultConsoleSink: LogSink = {
  write(level: LogLevel, serialized: string): void {
    if (level === 'error' || level === 'fatal') {
      console.error(serialized);
      return;
    }
    if (level === 'warn') {
      console.warn(serialized);
      return;
    }
    console.log(serialized);
  },
};

export class StructuredLogger {
  private readonly service: string;
  private readonly component?: string;
  private readonly levelResolver: () => LogLevel;
  private readonly defaultCategory: LogCategory;
  private readonly allowedFields?: ReadonlySet<string>;
  private readonly sink: LogSink;
  private readonly onWriteError?: (error: unknown) => void;
  private closed = false;
  private writeFailures = 0;
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(options: StructuredLoggerOptions) {
    this.service = options.service;
    this.component = options.component;
    const lvl = options.level;
    this.levelResolver = typeof lvl === 'function'
      ? lvl
      : lvl !== undefined
        ? () => lvl
        : () => resolveLogLevel(process.env.LOG_LEVEL);
    this.defaultCategory = options.defaultCategory ?? 'application';
    this.allowedFields = options.allowedFields;
    this.sink = options.sink ?? defaultConsoleSink;
    this.onWriteError = options.onWriteError;
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[this.levelResolver()];
  }

  getFailureCount(): number {
    return this.writeFailures;
  }

  child(overrides: { component?: string; defaultCategory?: LogCategory; allowedFields?: ReadonlySet<string> }): StructuredLogger {
    return new StructuredLogger({
      service: this.service,
      component: overrides.component ?? this.component,
      level: this.levelResolver,
      defaultCategory: overrides.defaultCategory ?? this.defaultCategory,
      allowedFields: overrides.allowedFields ?? this.allowedFields,
      sink: this.sink,
      onWriteError: this.onWriteError,
    });
  }

  debug(code: string, fields?: Record<string, unknown>): void {
    this.log('debug', this.defaultCategory, code, fields);
  }

  info(code: string, fields?: Record<string, unknown>): void {
    this.log('info', this.defaultCategory, code, fields);
  }

  warn(code: string, fields?: Record<string, unknown>): void {
    this.log('warn', this.defaultCategory, code, fields);
  }

  error(code: string, fields?: Record<string, unknown>): void {
    this.log('error', this.defaultCategory, code, fields);
  }

  fatal(code: string, fields?: Record<string, unknown>): void {
    this.log('fatal', this.defaultCategory, code, fields);
  }

  app(level: LogLevel, code: string, fields?: Record<string, unknown>): void {
    this.log(level, 'application', code, fields);
  }

  security(level: LogLevel, code: string, fields?: Record<string, unknown>): void {
    this.log(level, 'security', code, fields);
  }

  ops(level: LogLevel, code: string, fields?: Record<string, unknown>): void {
    this.log(level, 'operational', code, fields);
  }

  log(level: LogLevel, category: LogCategory, code: string, fields?: Record<string, unknown>): void {
    if (this.closed || !this.isLevelEnabled(level)) return;

    try {
      const ctx = getLogContext();
      const record: LogRecord = {
        timestamp: new Date().toISOString(),
        level,
        category,
        service: ctx?.service ?? this.service,
        code: scrubSensitiveString(code),
      };

      const component = fields?.component ?? this.component ?? ctx?.component;
      if (component !== undefined) {
        record.component = sanitizeLogValue(component, 'component');
      }
      if (ctx?.correlationId !== undefined) record.correlationId = ctx.correlationId;
      if (ctx?.tenantId !== undefined) record.tenantId = ctx.tenantId;
      if (ctx?.storeId !== undefined) record.storeId = ctx.storeId;
      if (ctx?.userId !== undefined) record.userId = ctx.userId;
      if (ctx?.jobName !== undefined) record.jobName = ctx.jobName;
      if (ctx?.batchId !== undefined) record.batchId = ctx.batchId;

      if (fields) {
        for (const [key, rawValue] of Object.entries(fields)) {
          if (rawValue === undefined || key === 'timestamp' || key === 'level' || key === 'category' || key === 'service' || key === 'code' || key === 'component') {
            continue;
          }
          if (this.allowedFields && !STANDARD_ENVELOPE_KEYS.has(key) && !this.allowedFields.has(key)) {
            continue;
          }
          record[key] = sanitizeLogValue(rawValue, key);
        }
      }

      const serialized = JSON.stringify(record);
      const result = this.sink.write(level, serialized);
      if (result && typeof (result as Promise<void>).then === 'function') {
        const tracked = Promise.resolve(result)
          .catch(err => this.handleWriteFailure(err))
          .finally(() => {
            this.pendingWrites.delete(tracked);
          });
        this.pendingWrites.add(tracked);
      }
    } catch (err) {
      this.handleWriteFailure(err);
    }
  }

  async flush(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
    if (this.sink.flush) {
      await this.sink.flush().catch(err => this.handleWriteFailure(err));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    if (this.sink.close) {
      await this.sink.close().catch(err => this.handleWriteFailure(err));
    }
  }

  private handleWriteFailure(error: unknown): void {
    this.writeFailures++;
    if (this.onWriteError) {
      try {
        this.onWriteError(error);
      } catch {
        // Logging failures must never escape to callers.
      }
      return;
    }
    try {
      const errorType = error instanceof Error ? error.name : typeof error;
      process.stderr.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', category: 'operational', service: this.service, code: 'LOGGING_WRITE_FAILED', errorType })}\n`,
      );
    } catch {
      // Suppress if stderr itself is unavailable during shutdown.
    }
  }
}

export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  return new StructuredLogger(options);
}

export const apiLogger = createStructuredLogger({ service: 'omnihub-api' });
export const workerLogger = createStructuredLogger({ service: 'omnihub-worker', defaultCategory: 'operational' });
