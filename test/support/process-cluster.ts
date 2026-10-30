import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Instance {
  port: number;
  pid: number;
  url: string;
  output(): string;
  isRunning(): boolean;
  kill(): Promise<void>;
}

function bunExecutable(): string {
  if (process.env.BUN_BIN) return process.env.BUN_BIN;
  const candidates = [
    join(
      homedir(),
      '.bun',
      'bin',
      process.platform === 'win32' ? 'bun.exe' : 'bun',
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'bun';
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilReady(
  instance: Instance,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!instance.isRunning()) {
      throw new Error(
        `instance on port ${instance.port} exited early:\n${instance.output()}`,
      );
    }
    try {
      const response = await fetch(`${instance.url}/health/ready`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `instance on port ${instance.port} was not ready in ${timeoutMs}ms:\n${instance.output()}`,
  );
}

export async function startInstance(
  env: Record<string, string>,
  { readyTimeoutMs = 60_000 } = {},
): Promise<Instance> {
  const port = await freePort();
  const child: ChildProcess = spawn(bunExecutable(), ['src/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  let exited = false;
  const capture = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString()).slice(-6_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('exit', () => {
    exited = true;
  });

  const instance: Instance = {
    port,
    pid: child.pid!,
    url: `http://127.0.0.1:${port}`,
    output: () => buffer,
    isRunning: () => !exited,
    kill: async () => {
      if (exited) return;
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
  await waitUntilReady(instance, readyTimeoutMs);
  return instance;
}
