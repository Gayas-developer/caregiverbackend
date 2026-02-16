"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupRealtimeHub = setupRealtimeHub;
exports.publishOrgEvent = publishOrgEvent;
const crypto_1 = require("crypto");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const ws_1 = require("ws");
const auth_1 = require("../utils/auth");
const clients = new Set();
const parseTokenFromRequest = (req) => {
    const fullUrl = req.url || '/';
    const parsed = new URL(fullUrl, 'http://localhost');
    const tokenFromQuery = parsed.searchParams.get('token');
    if (tokenFromQuery)
        return tokenFromQuery;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return null;
};
const verifyAccessToken = async (token) => {
    try {
        const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_ACCESS_SECRET);
        if (payload.type !== 'access')
            return null;
        const revoked = await (0, auth_1.isTokenRevoked)(payload.jti);
        if (revoked)
            return null;
        return payload;
    }
    catch {
        return null;
    }
};
const canReceiveEvent = (client, event, options) => {
    if (client.ctx.orgId !== event.orgId)
        return false;
    if (options?.userId && client.ctx.userId !== options.userId)
        return false;
    if (options?.roles?.length && !options.roles.includes(client.ctx.role)) {
        return false;
    }
    if (options?.branchId && client.ctx.role !== 'ORG_ADMIN') {
        return client.ctx.branchId === options.branchId;
    }
    return true;
};
function setupRealtimeHub(server) {
    const wss = new ws_1.WebSocketServer({ server, path: '/ws' });
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
            const client = {
                ws,
                ctx: {
                    userId: payload.sub,
                    orgId: payload.orgId,
                    branchId: payload.branchId || null,
                    role: payload.role,
                },
            };
            clients.add(client);
            ws.send(JSON.stringify({
                type: 'WS_CONNECTED',
                at: new Date().toISOString(),
                userId: payload.sub,
                orgId: payload.orgId,
            }));
            ws.on('close', () => {
                clients.delete(client);
            });
            ws.on('error', () => {
                clients.delete(client);
            });
        })();
    });
}
function publishOrgEvent(orgId, type, payload, options) {
    const event = {
        id: (0, crypto_1.randomUUID)(),
        type,
        at: new Date().toISOString(),
        orgId,
        branchId: options?.branchId || null,
        payload,
    };
    for (const client of clients) {
        if (!canReceiveEvent(client, event, options))
            continue;
        if (client.ws.readyState !== ws_1.WebSocket.OPEN)
            continue;
        client.ws.send(JSON.stringify(event));
    }
}
