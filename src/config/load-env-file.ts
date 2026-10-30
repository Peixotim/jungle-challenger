export function loadEnvFile(path = '.env'): void {
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
