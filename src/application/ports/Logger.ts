export type LogFields = Record<string, unknown>;

export abstract class Logger {
  abstract info(message: string, fields?: LogFields): void;
  abstract warn(message: string, fields?: LogFields): void;
  abstract error(message: string, fields?: LogFields): void;
}
