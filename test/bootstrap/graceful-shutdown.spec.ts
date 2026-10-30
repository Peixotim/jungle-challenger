import { EventEmitter } from 'node:events';
import { registerGracefulShutdown } from '../../src/bootstrap/graceful-shutdown.js';
import { LifecycleState } from '../../src/infrastructure/lifecycle/LifecycleState.js';
import { RecordingLogger } from '../application/fakes/InMemoryDatabase.js';

function setup(
  close: () => Promise<void> = () => Promise.resolve(),
  timeoutMs = 5_000,
) {
  const processRef = new EventEmitter();
  const exit = vi.fn();
  const closeSpy = vi.fn(close);
  const logger = new RecordingLogger();
  const lifecycle = new LifecycleState();
  const { shutdown } = registerGracefulShutdown({
    app: { close: closeSpy },
    logger,
    lifecycle,
    timeoutMs,
    processRef: processRef as unknown as Pick<NodeJS.Process, 'on'>,
    exit,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { processRef, exit, closeSpy, logger, lifecycle, shutdown, settle };
}

describe('registerGracefulShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['SIGTERM', 'SIGINT'])(
    'closes the app and exits 0 on %s',
    async (signal) => {
      const { processRef, exit, closeSpy, lifecycle, settle } = setup();

      processRef.emit(signal);
      await settle();

      expect(lifecycle.isShuttingDown).toBe(true);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    },
  );

  it('marks the service as shutting down before it starts closing', async () => {
    let seenWhileClosing: boolean | undefined;
    const lifecycle = new LifecycleState();
    const processRef = new EventEmitter();
    registerGracefulShutdown({
      app: {
        close: () => {
          seenWhileClosing = lifecycle.isShuttingDown;
          return Promise.resolve();
        },
      },
      logger: new RecordingLogger(),
      lifecycle,
      timeoutMs: 1_000,
      processRef: processRef as unknown as Pick<NodeJS.Process, 'on'>,
      exit: vi.fn(),
    });

    processRef.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(seenWhileClosing).toBe(true);
  });

  it('ignores repeated signals while shutting down', async () => {
    const { processRef, exit, closeSpy, settle } = setup();

    processRef.emit('SIGTERM');
    processRef.emit('SIGINT');
    processRef.emit('SIGTERM');
    await settle();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when closing fails', async () => {
    const { processRef, exit, logger, settle } = setup(() =>
      Promise.reject(new Error('pool stuck')),
    );

    processRef.emit('SIGTERM');
    await settle();

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(
      logger.entries.some(
        (e) => e.level === 'error' && e.message === 'shutdown failed',
      ),
    ).toBe(true);
  });

  it('forces exit 1 when closing takes longer than the timeout', async () => {
    vi.useFakeTimers();
    const { processRef, exit, logger } = setup(
      () => new Promise(() => undefined),
      3_000,
    );

    processRef.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(
      logger.entries.some(
        (e) => e.message === 'shutdown timed out, forcing exit',
      ),
    ).toBe(true);
  });

  it('logs and shuts down with exit 1 on an unhandled rejection', async () => {
    const { processRef, exit, logger, closeSpy, settle } = setup();

    processRef.emit('unhandledRejection', new Error('nobody caught me'));
    await settle();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logger.entries[0]).toMatchObject({
      level: 'error',
      message: 'unhandled promise rejection',
    });
  });

  it('logs and shuts down with exit 1 on an uncaught exception', async () => {
    const { processRef, exit, logger, settle } = setup();

    processRef.emit('uncaughtException', new Error('kaput'));
    await settle();

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logger.entries[0]).toMatchObject({
      level: 'error',
      message: 'uncaught exception',
    });
  });
});
