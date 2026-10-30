import type { Response } from 'express';
import { HealthIndicator } from '../../src/application/ports/HealthIndicator.js';
import { LifecycleState } from '../../src/infrastructure/lifecycle/LifecycleState.js';
import { HealthController } from '../../src/interface/http/controllers/HealthController.js';
import { httpStatusFor } from '../../src/interface/http/presenters/submit-status.js';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/enums/WagerTransactionStatus.js';
import { RecordingLogger } from '../application/fakes/InMemoryDatabase.js';

class FakeIndicator extends HealthIndicator {
  constructor(
    readonly name: string,
    private readonly behaviour: () => Promise<void>,
  ) {
    super();
  }

  check(): Promise<void> {
    return this.behaviour();
  }
}

const up = (name: string) => new FakeIndicator(name, () => Promise.resolve());
const down = (name: string) =>
  new FakeIndicator(name, () =>
    Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
  );
const hanging = (name: string) =>
  new FakeIndicator(name, () => new Promise(() => undefined));

function setup(
  indicators: HealthIndicator[],
  lifecycle = new LifecycleState(),
) {
  const logger = new RecordingLogger();
  const controller = new HealthController(indicators, lifecycle, logger);
  const response = { status: vi.fn() } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
  };
  return { controller, logger, response, lifecycle };
}

describe('HealthController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('live is always up', () => {
    expect(setup([]).controller.live()).toEqual({ status: 'up' });
  });

  it('live stays up while shutting down, so the process is not killed early', () => {
    const lifecycle = new LifecycleState();
    lifecycle.markShuttingDown();
    expect(setup([], lifecycle).controller.live()).toEqual({ status: 'up' });
  });

  it('ready is up when every dependency answers', async () => {
    const { controller, response } = setup([up('postgres'), up('sqs')]);

    const body = await controller.ready(response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(body).toMatchObject({
      status: 'up',
      checks: { postgres: { status: 'up' }, sqs: { status: 'up' } },
    });
  });

  it('ready is 503 and names the dependency that failed, without leaking the cause', async () => {
    const { controller, response, logger } = setup([
      up('postgres'),
      down('sqs'),
    ]);

    const body = await controller.ready(response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(body).toMatchObject({
      status: 'down',
      checks: {
        postgres: { status: 'up' },
        sqs: { status: 'down', reason: 'unreachable' },
      },
    });
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
    expect(logger.entries[0]).toMatchObject({
      level: 'warn',
      fields: { check: 'sqs' },
    });
  });

  it('ready times out a dependency that hangs', async () => {
    vi.useFakeTimers();
    const { controller, response } = setup([hanging('postgres')]);

    const pending = controller.ready(response);
    await vi.advanceTimersByTimeAsync(2_000);
    const body = await pending;

    expect(response.status).toHaveBeenCalledWith(503);
    expect(body).toMatchObject({
      checks: { postgres: { status: 'down', reason: 'timeout' } },
    });
  });

  it('ready is 503 as soon as shutdown starts, without touching dependencies', async () => {
    const lifecycle = new LifecycleState();
    lifecycle.markShuttingDown();
    const check = vi.fn(() => Promise.resolve());
    const { controller, response } = setup(
      [new FakeIndicator('postgres', check)],
      lifecycle,
    );

    const body = await controller.ready(response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: 'shutting_down', checks: {} });
    expect(check).not.toHaveBeenCalled();
  });
});

describe('httpStatusFor', () => {
  it('distinguishes processed, pending and rejected outcomes', () => {
    expect(httpStatusFor(Status.Processed)).toBe(200);
    expect(httpStatusFor(Status.PendingReference)).toBe(202);
    expect(httpStatusFor(Status.Pending)).toBe(202);
    expect(httpStatusFor(Status.Rejected)).toBe(422);
    expect(httpStatusFor(Status.Failed)).toBe(500);
  });
});
