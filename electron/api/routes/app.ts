import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { setCorsHeaders, sendNoContent } from '../route-utils';

export async function handleAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/events' && req.method === 'GET') {
    setCorsHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    ctx.eventBus.addSseClient(res);
    return true;
  }

  if (req.method === 'OPTIONS') {
    sendNoContent(res);
    return true;
  }

  return false;
}
