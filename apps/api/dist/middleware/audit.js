"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.audit = audit;
const prisma_1 = require("../utils/prisma");
function redact(input) {
    const SENSITIVE_KEYS = new Set([
        'password',
        'passwordHash',
        'token',
        'refresh',
        'access',
        'authorization',
        'cookie'
    ]);
    const walk = (v) => {
        if (v == null)
            return v;
        if (Array.isArray(v))
            return v.map(walk);
        if (typeof v === 'object') {
            const out = {};
            for (const [k, val] of Object.entries(v)) {
                if (SENSITIVE_KEYS.has(k.toLowerCase()))
                    out[k] = '[REDACTED]';
                else
                    out[k] = walk(val);
            }
            return out;
        }
        return v;
    };
    return walk(input);
}
async function audit(req, _res, next) {
    const method = req.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
        return next();
    try {
        const actorId = req.user?.sub || null;
        const orgId = req.ctx?.orgId || null;
        await prisma_1.prisma.auditLog.create({
            data: {
                orgId: orgId || 'unknown',
                actorId,
                entity: 'HTTP',
                entityId: req.path,
                action: method,
                details: {
                    method,
                    path: req.path,
                    orgId,
                    actorId,
                    query: redact(req.query),
                    body: redact(req.body)
                }
            }
        });
    }
    catch { }
    next();
}
