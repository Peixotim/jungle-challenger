const BASE_MS = 1_000;
const MAX_MS = 5 * 60_000;

export function backoffUntil(attempts: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(MAX_MS, BASE_MS * 2 ** attempts));
}
