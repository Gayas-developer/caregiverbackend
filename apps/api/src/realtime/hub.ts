import { randomUUID } from 'crypto';
import { IncomingMessage, Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import { isTokenRevoked, JwtPayload } from '../utils/auth';

type RealtimeClientContext = {
  userId: string;
  orgId: string;
  branchId: string | null;
  role: string;
};

type RealtimeClient = {
  ws: WebSocket;
  ctx: RealtimeClientContext;
};

type PublishOptions = {
  branchId?: string | null;
  roles?: string[];
  userId?: string;
};

export type RealtimeEvent = {
  id: string;
  type: string;
  at: string;
  orgId: string;
  branchId?: string | null;
  payload: Record<string, any>;
};

const clients = new Set<RealtimeClient>();

const parseTokenFromRequest = (req: IncomingMessage) => {
  const fullUrl = req.url || '/';
  const parsed = new URL(fullUrl, 'http://localhost');

  const tokenFromQuery = parsed.searchParams.get('token');
  if (tokenFromQuery) return tokenFromQuery;

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
};

const verifyAccessToken = async (token: string): Promise<JwtPayload | null> => {
  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_ACCESS_SECRET!,
    ) as JwtPayload;

    if (payload.type !== 'access') return null;

    const revoked = await isTokenRevoked(payload.jti);
    if (revoked) return null;

    return payload;
  } catch {
    return null;
  }
};

const canReceiveEvent = (
  client: RealtimeClient,
  event: RealtimeEvent,
  options?: PublishOptions,
) => {
  if (client.ctx.orgId !== event.orgId) return false;
  if (options?.userId && client.ctx.userId !== options.userId) return false;
  if (options?.roles?.length && !options.roles.includes(client.ctx.role)) {
    return false;
  }
  if (options?.branchId && client.ctx.role !== 'ORG_ADMIN') {
    return client.ctx.branchId === options.branchId;
  }
  return true;
};

export function setupRealtimeHub(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    (async () => {
      const token = parseTokenFromRequest(req);
      if (!token) {
        ws.close(1008, 'Unauthorized');
        return;
      }

      const payload = await verifyAccessToken(token);
      if (!payload?.sub || !payload.orgId) {
        ws.close(1008, 'Unauthorized');
        return;
      }

      const client: RealtimeClient = {
        ws,
        ctx: {
          userId: payload.sub,
          orgId: payload.orgId,
          branchId: payload.branchId || null,
          role: payload.role,
        },
      };
      clients.add(client);

      ws.send(
        JSON.stringify({
          type: 'WS_CONNECTED',
          at: new Date().toISOString(),
          userId: payload.sub,
          orgId: payload.orgId,
        }),
      );

      ws.on('close', () => {
        clients.delete(client);
      });
      ws.on('error', () => {
        clients.delete(client);
      });
    })();
  });
}

export function publishOrgEvent(
  orgId: string,
  type: string,
  payload: Record<string, any>,
  options?: PublishOptions,
) {
  const event: RealtimeEvent = {
    id: randomUUID(),
    type,
    at: new Date().toISOString(),
    orgId,
    branchId: options?.branchId || null,
    payload,
  };

  for (const client of clients) {
    if (!canReceiveEvent(client, event, options)) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    client.ws.send(JSON.stringify(event));
  }
}
