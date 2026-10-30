export class OptimisticLockError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was changed by another transaction`);
    this.name = 'OptimisticLockError';
  }
}
