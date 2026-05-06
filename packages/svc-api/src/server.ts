import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ServerOptions {
  port: number;
  host?: string;
}

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

const defaultHandler: RequestHandler = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
};

export function createApiServer(
  handler: RequestHandler = defaultHandler,
): ReturnType<typeof createServer> {
  return createServer(handler);
}

export function startServer(
  options: ServerOptions,
  handler?: RequestHandler,
): Promise<ReturnType<typeof createServer>> {
  const server = createApiServer(handler);
  const { port, host = '0.0.0.0' } = options;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}
