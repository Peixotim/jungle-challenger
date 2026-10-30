export abstract class HealthIndicator {
  abstract readonly name: string;

  abstract check(): Promise<void>;
}
