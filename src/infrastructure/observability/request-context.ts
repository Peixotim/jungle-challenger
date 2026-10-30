import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(context: RequestContext, work: () => T): T {
    return storage.run(context, work);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },
};
