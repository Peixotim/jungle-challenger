export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      `invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

interface NumberOptions {
  default: number;
  min?: number;
  max?: number;
}

export class EnvReader {
  readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  private raw(name: string): string | undefined {
    const value = this.env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  string(name: string, fallback: string): string {
    return this.raw(name) ?? fallback;
  }

  requiredUrl(name: string, protocols: readonly string[]): string {
    const value = this.raw(name);
    if (value === undefined) {
      this.problems.push(`${name} is required`);
      return '';
    }
    try {
      const url = new URL(value);
      if (!protocols.includes(url.protocol)) {
        this.problems.push(
          `${name} must use one of ${protocols.join(', ')} (got ${url.protocol})`,
        );
      }
    } catch {
      this.problems.push(`${name} is not a valid URL`);
    }
    return value;
  }

  integer(name: string, options: NumberOptions): number {
    const value = this.raw(name);
    if (value === undefined) return options.default;
    if (!/^-?\d+$/.test(value)) {
      this.problems.push(`${name} must be an integer (got "${value}")`);
      return options.default;
    }
    const parsed = Number(value);
    if (options.min !== undefined && parsed < options.min) {
      this.problems.push(`${name} must be >= ${options.min} (got ${parsed})`);
    }
    if (options.max !== undefined && parsed > options.max) {
      this.problems.push(`${name} must be <= ${options.max} (got ${parsed})`);
    }
    return parsed;
  }

  boolean(name: string, fallback: boolean): boolean {
    const value = this.raw(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    this.problems.push(`${name} must be "true" or "false" (got "${value}")`);
    return fallback;
  }

  oneOf<T extends string>(name: string, values: readonly T[], fallback: T): T {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    if ((values as readonly string[]).includes(value)) return value as T;
    this.problems.push(
      `${name} must be one of ${values.join(', ')} (got "${value}")`,
    );
    return fallback;
  }

  pattern(name: string, regex: RegExp, fallback: string, hint: string): string {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    if (regex.test(value)) return value;
    this.problems.push(`${name} ${hint} (got "${value}")`);
    return fallback;
  }

  trustProxy(name: string): boolean | number {
    const value = this.raw(name)?.toLowerCase();
    if (value === undefined || value === 'false') return false;
    if (value === 'true') return true;
    if (/^\d+$/.test(value)) return Number(value);
    this.problems.push(
      `${name} must be "true", "false" or a number of hops (got "${value}")`,
    );
    return false;
  }
}
