import { PrometheusMetrics } from '../../src/infrastructure/observability/PrometheusMetrics.js';

describe('PrometheusMetrics', () => {
  it('renders nothing before any measurement', () => {
    expect(new PrometheusMetrics().render()).toBe('');
  });

  it('counts increments per label set', () => {
    const metrics = new PrometheusMetrics();

    metrics.increment('wager_transactions_total', { status: 'PROCESSED' });
    metrics.increment('wager_transactions_total', { status: 'PROCESSED' });
    metrics.increment('wager_transactions_total', { status: 'REJECTED' });
    metrics.increment('outbox_publish_failures_total');

    expect(metrics.render()).toBe(
      [
        '# TYPE outbox_publish_failures_total counter',
        'outbox_publish_failures_total 1',
        '# TYPE wager_transactions_total counter',
        'wager_transactions_total{status="PROCESSED"} 2',
        'wager_transactions_total{status="REJECTED"} 1',
        '',
      ].join('\n'),
    );
  });

  it('records histograms with cumulative buckets, sum and count', () => {
    const metrics = new PrometheusMetrics([0.1, 1, 10]);

    metrics.observe('outbox_lag_seconds', 0.05);
    metrics.observe('outbox_lag_seconds', 0.5);
    metrics.observe('outbox_lag_seconds', 5);
    metrics.observe('outbox_lag_seconds', 50);

    expect(metrics.render()).toBe(
      [
        '# TYPE outbox_lag_seconds histogram',
        'outbox_lag_seconds_bucket{le="0.1"} 1',
        'outbox_lag_seconds_bucket{le="1"} 2',
        'outbox_lag_seconds_bucket{le="10"} 3',
        'outbox_lag_seconds_bucket{le="+Inf"} 4',
        'outbox_lag_seconds_sum 55.55',
        'outbox_lag_seconds_count 4',
        '',
      ].join('\n'),
    );
  });

  it('keeps labels with a histogram next to the bucket bound', () => {
    const metrics = new PrometheusMetrics([1]);

    metrics.observe('latency_seconds', 0.2, { route: '/wallets' });

    expect(metrics.render()).toContain(
      'latency_seconds_bucket{route="/wallets",le="1"} 1',
    );
    expect(metrics.render()).toContain(
      'latency_seconds_count{route="/wallets"} 1',
    );
  });

  it('orders labels deterministically and escapes their values', () => {
    const metrics = new PrometheusMetrics();

    metrics.increment('events_total', {
      b: 'x',
      a: 'quote " back \\ line\nbreak',
    });

    expect(metrics.render()).toContain(
      'events_total{a="quote \\" back \\\\ line\\nbreak",b="x"} 1',
    );
  });

  it('ignores invalid names, labels and values instead of throwing', () => {
    const metrics = new PrometheusMetrics();

    expect(() => {
      metrics.increment('9-bad name');
      metrics.increment('ok_total', { 'bad-label': 'x' });
      metrics.observe('latency_seconds', Number.NaN);
      metrics.observe('latency_seconds', Number.POSITIVE_INFINITY);
    }).not.toThrow();
    expect(metrics.render()).toBe('');
  });

  it('refuses to reuse a name for a different metric type', () => {
    const metrics = new PrometheusMetrics([1]);
    metrics.increment('shared_name');

    metrics.observe('shared_name', 1);

    expect(metrics.render()).toBe(
      '# TYPE shared_name counter\nshared_name 1\n',
    );
  });

  it('caps the number of series per metric to protect memory', () => {
    const metrics = new PrometheusMetrics();

    for (let i = 0; i < 1_500; i++)
      metrics.increment('unbounded_total', { id: String(i) });

    const series = metrics
      .render()
      .split('\n')
      .filter((line) => line.startsWith('unbounded_total{'));
    expect(series).toHaveLength(1_000);
  });
});
