import { Logger } from '../application/ports/Logger.js';
import { LifecycleState } from '../infrastructure/lifecycle/LifecycleState.js';

export interface ClosableApp {
  close(): Promise<void>;
}

export interface GracefulShutdownOptions {
  app: ClosableApp;
  logger: Logger;
  lifecycle: LifecycleState;
  timeoutMs: number;
  processRef?: Pick<NodeJS.Process, 'on'>;
  exit?: (code: number) => void;
}

export function registerGracefulShutdown(options: GracefulShutdownOptions): {
  shutdown: (reason: string, exitCode: number) => Promise<void>;
} {
  const { app, logger, lifecycle, timeoutMs } = options;
  const processRef = options.processRef ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (started) return;
    started = true;
    lifecycle.markShuttingDown();
    logger.info('shutdown started', { reason, timeoutMs });

    const timer = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit', { reason, timeoutMs });
      exit(1);
    }, timeoutMs);
    timer.unref();

    try {
      await app.close();
      clearTimeout(timer);
      logger.info('shutdown complete', { reason });
      exit(exitCode);
    } catch (error) {
      clearTimeout(timer);
      logger.error('shutdown failed', { reason, err: error });
      exit(1);
    }
  };

  processRef.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  processRef.on('SIGINT', () => void shutdown('SIGINT', 0));
  processRef.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason });
    void shutdown('unhandledRejection', 1);
  });
  processRef.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { err: error });
    void shutdown('uncaughtException', 1);
  });

  return { shutdown };
}
