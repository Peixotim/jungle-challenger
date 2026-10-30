import { MetricLabels, Metrics } from '../../application/ports/Metrics.js';

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_SERIES_PER_METRIC = 1_000;
const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300,
];

interface Histogram {
  counts: number[];
  sum: number;
  count: number;
}

export class PrometheusMetrics extends Metrics {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();

  constructor(private readonly buckets: readonly number[] = DEFAULT_BUCKETS) {
    super();
  }

  increment(name: string, labels: MetricLabels = {}): void {
    const key = this.seriesKey(name, labels, this.histograms);
    if (key === undefined) return;
    const series = this.counters.get(name) ?? new Map<string, number>();
    if (!series.has(key) && series.size >= MAX_SERIES_PER_METRIC) return;
    series.set(key, (series.get(key) ?? 0) + 1);
    this.counters.set(name, series);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) return;
    const key = this.seriesKey(name, labels, this.counters);
    if (key === undefined) return;
    const series = this.histograms.get(name) ?? new Map<string, Histogram>();
    let histogram = series.get(key);
    if (!histogram) {
      if (series.size >= MAX_SERIES_PER_METRIC) return;
      histogram = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      series.set(key, histogram);
    }
    this.buckets.forEach((bound, index) => {
      if (value <= bound) histogram.counts[index] += 1;
    });
    histogram.sum += value;
    histogram.count += 1;
    this.histograms.set(name, series);
  }

  render(): string {
    const lines: string[] = [];
    for (const name of [...this.counters.keys()].sort()) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of sortedEntries(this.counters.get(name)!)) {
        lines.push(`${name}${braces(key)} ${value}`);
      }
    }
    for (const name of [...this.histograms.keys()].sort()) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, histogram] of sortedEntries(
        this.histograms.get(name)!,
      )) {
        this.buckets.forEach((bound, index) => {
          lines.push(
            `${name}_bucket${braces(key, `le="${bound}"`)} ${histogram.counts[index]}`,
          );
        });
        lines.push(
          `${name}_bucket${braces(key, 'le="+Inf"')} ${histogram.count}`,
        );
        lines.push(`${name}_sum${braces(key)} ${histogram.sum}`);
        lines.push(`${name}_count${braces(key)} ${histogram.count}`);
      }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  private seriesKey(
    name: string,
    labels: MetricLabels,
    ofOtherType: Map<string, unknown>,
  ): string | undefined {
    if (!NAME.test(name) || ofOtherType.has(name)) return undefined;
    const entries = Object.entries(labels).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (entries.some(([label]) => !LABEL_NAME.test(label))) return undefined;
    return entries
      .map(([label, value]) => `${label}="${escape(String(value))}"`)
      .join(',');
  }
}

function braces(labels: string, extra?: string): string {
  const all = [labels, extra].filter((part) => part).join(',');
  return all ? `{${all}}` : '';
}

function escape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function sortedEntries<T>(map: Map<string, T>): [string, T][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
