import net from 'node:net';

export interface TcpProxy {
  port: number;
  cut(): Promise<void>;
  restore(): Promise<void>;
  close(): Promise<void>;
}

export async function startTcpProxy(
  targetHost: string,
  targetPort: number,
): Promise<TcpProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

  await listen(0);
  const port = (server.address() as net.AddressInfo).port;

  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  return {
    port,
    cut: stop,
    restore: () => (server.listening ? Promise.resolve() : listen(port)),
    close: stop,
  };
}
