import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ServerOptions {
  port: number;
  host?: string;
}

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export const defaultHandler: RequestHandler = (req, res) => {
  const method = req.method ?? '';
  const url = req.url ?? '/';

  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (url === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (url === '/hello') {
    sendJson(res, 200, { message: 'hello' });
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
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
