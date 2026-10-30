import { Counter } from 'k6/metrics';
import { reconcile } from './api.js';

export const integrityFailures = new Counter('integrity_failures');

export const integrityThreshold = { integrity_failures: ['count==0'] };

// Fails the run if any wallet's stored balance differs from the ledger-derived one.
export function assertReconciled(walletIds) {
  for (const id of walletIds) {
    const result = reconcile(id);
    if (!result.consistent) {
      console.error(`wallet ${id} is inconsistent: ${JSON.stringify(result)}`);
      integrityFailures.add(1);
    } else {
      integrityFailures.add(0);
    }
  }
}
