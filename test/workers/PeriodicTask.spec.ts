import { PeriodicTask } from '../../src/interface/workers/PeriodicTask.js';
import {
  RecordingLogger,
  RecordingMetrics,
} from '../application/fakes/InMemoryDatabase.js';

function setup(run: () => Promise<boolean>, intervalMs = 1_000) {
  const logger = new RecordingLogger();
  const metrics = new RecordingMetrics();
  const task = new PeriodicTask('test-task', run, intervalMs, logger, metrics);
  return { task, logger, metrics };
}

describe('PeriodicTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once immediately, then once per interval', async () => {
    const run = vi.fn(() => Promise.resolve(false));
    const { task } = setup(run);

    task.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    await task.stop();
  });

  it('runs again straight away while there is more work', async () => {
    const answers = [true, true, false];
    const run = vi.fn(() => Promise.resolve(answers.shift() ?? false));
    const { task } = setup(run);

    task.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(3);
    await task.stop();
  });

  it('never runs two ticks at the same time', async () => {
    let active = 0;
    let peak = 0;
    const run = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      active -= 1;
      return false;
    });
    const { task } = setup(run, 100);

    task.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(run.mock.calls.length).toBeGreaterThan(2);
    expect(peak).toBe(1);
    const stopping = task.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
  });

  it('survives a failing tick: logs, counts, and keeps its schedule', async () => {
    const run = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(false);
    const { task, logger, metrics } = setup(run);

    task.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.entries[0]).toMatchObject({
      level: 'error',
      message: 'worker tick failed',
    });
    expect(metrics.counters).toEqual([
      { name: 'worker_failures_total', labels: { task: 'test-task' } },
      { name: 'worker_ticks_total', labels: { task: 'test-task' } },
    ]);
    await task.stop();
  });

  it('waits for the interval after a failure instead of spinning', async () => {
    const run = vi.fn(() => Promise.reject(new Error('always broken')));
    const { task } = setup(run, 1_000);

    task.start();
    await vi.advanceTimersByTimeAsync(3_500);

    expect(run.mock.calls.length).toBeLessThanOrEqual(4);
    await task.stop();
  });

  it('stop wakes a sleeping task right away', async () => {
    const run = vi.fn(() => Promise.resolve(false));
    const { task } = setup(run, 60_000);
    task.start();
    await vi.advanceTimersByTimeAsync(0);

    await task.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop waits for the tick in flight and prevents the next one', async () => {
    let finishTick!: () => void;
    const run = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishTick = () => resolve(true);
        }),
    );
    const { task } = setup(run);
    task.start();
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = task.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finishTick();
    await stopping;

    expect(stopped).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('start is idempotent', async () => {
    const run = vi.fn(() => Promise.resolve(false));
    const { task } = setup(run);

    task.start();
    task.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(1);
    await task.stop();
  });
});
