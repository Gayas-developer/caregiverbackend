import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma';

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
        details: { headers: req.headers, query: req.query, body: req.body }
      }
    });
  } catch {}
  next();
}
