export type MetricLabels = Record<string, string>;

export abstract class Metrics {
  abstract increment(name: string, labels?: MetricLabels): void;
  abstract observe(name: string, value: number, labels?: MetricLabels): void;
}
