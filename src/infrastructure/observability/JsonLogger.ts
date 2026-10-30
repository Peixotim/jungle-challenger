import type { LoggerService } from '@nestjs/common';
import type { LogLevel } from '../../config/app-config.js';
import { LogFields, Logger } from '../../application/ports/Logger.js';
import { requestContext } from './request-context.js';

type Level = LogLevel | 'fatal';

const SEVERITY: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const RESERVED = new Set([
  'time',
  'level',
  'service',
  'correlationId',
  'context',
  'message',
]);
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential/i;
const STACK_LIKE = /\n\s+at /;
const MAX_DEPTH = 5;
const MAX_ARRAY = 20;
const MAX_STRING = 2_000;

export interface JsonLoggerOptions {
  level: LogLevel;
  service: string;
  write?: (line: string) => void;
}

export class JsonLogger extends Logger implements LoggerService {
  private readonly write: (line: string) => void;

  constructor(private readonly options: JsonLoggerOptions) {
    super();
    this.write =
      options.write ?? ((line) => void process.stdout.write(`${line}\n`));
  }

  info(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    if (SEVERITY[level] < SEVERITY[this.options.level]) return;

    const fields: LogFields = {};
    let context: string | undefined;
    let stack: string | undefined;
    for (const param of params) {
      if (typeof param === 'string') {
        if (STACK_LIKE.test(param)) stack = param;
        else context = param;
      } else if (param instanceof Error) {
        fields.err = param;
      } else if (param !== null && typeof param === 'object') {
        Object.assign(fields, param);
      }
    }

    let text: string;
    if (message instanceof Error) {
      fields.err ??= message;
      text = message.message;
    } else if (typeof message === 'string') {
      text = message;
    } else {
      text = safeStringify(message);
    }
    if (stack) fields.stack = stack;

    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      service: this.options.service,
    };
    const correlationId = requestContext.correlationId();
    if (correlationId) record.correlationId = correlationId;
    if (context) record.context = context;
    record.message = truncate(text);

    for (const [key, value] of Object.entries(fields)) {
      if (!RESERVED.has(key)) record[key] = sanitize(key, value, 0);
    }
    this.write(safeStringify(record));
  }
}

function sanitize(key: string, value: unknown, depth: number): unknown {
  if (SENSITIVE_KEY.test(key) || key === 'payload' || key === 'body')
    return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((item) => sanitize(key, item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, sanitize(k, v, depth + 1)]),
  );
}

function truncate(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  } catch {
    return '"[Unserializable]"';
  }
}
