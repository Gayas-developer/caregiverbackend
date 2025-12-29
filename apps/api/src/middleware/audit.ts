import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';

function redact(input: any) {
  const SENSITIVE_KEYS = new Set([
    'password',
    'passwordHash',
    'token',
    'refresh',
    'access',
    'authorization',
    'cookie'
  ]);

  const walk = (v: any): any => {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) {
        if (SENSITIVE_KEYS.has(k.toLowerCase())) out[k] = '[REDACTED]';
        else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };

  return walk(input);
}

export async function audit(req: Request, _res: Response, next: NextFunction) {
  const method = req.method.toUpperCase();
  if (!['POST','PUT','PATCH','DELETE'].includes(method)) return next();
  try {
    const actorId = (req as any).user?.sub || null;
    const orgId = (req as any).ctx?.orgId || null;
    await prisma.auditLog.create({
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
  } catch {}
  next();
}
