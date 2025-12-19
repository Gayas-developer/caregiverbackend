import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { prisma } from './prisma';

export type JwtPayload = {
  sub: string;
  orgId: string;
  branchId?: string | null;
  role: string;
  type: 'access' | 'refresh';
  jti: string;
};

export function signAccessToken(payload: Omit<JwtPayload, 'type'|'jti'>) {
  const secret = process.env.JWT_ACCESS_SECRET!;
  const jti = crypto.randomUUID();
  return jwt.sign({ ...payload, type: 'access', jti }, secret, { expiresIn: '15m' });
}

export function signRefreshToken(payload: Omit<JwtPayload, 'type'|'jti'>) {
  const secret = process.env.JWT_REFRESH_SECRET!;
  const jti = crypto.randomUUID();
  return jwt.sign({ ...payload, type: 'refresh', jti }, secret, { expiresIn: '7d' });
}

export function verifyRefreshToken(token: string): JwtPayload {
  const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as JwtPayload;
  return payload;
}

export async function revokeToken(jti: string, type: 'access'|'refresh', expSeconds: number) {
  const expiresAt = new Date(Date.now() + expSeconds * 1000);
  await prisma.revokedToken.create({ data: { jti, type, expiresAt } });
}

export async function isTokenRevoked(jti: string) {
  const found = await prisma.revokedToken.findUnique({ where: { jti } });
  return !!found;
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as JwtPayload;
    (req as any).user = payload;
    next();
  } catch {
    next(Object.assign(new Error('Unauthorized'), { status: 401 }));
  }
}

export function tenantScope(req: Request, _res: Response, next: NextFunction) {
  const user = (req as any).user as JwtPayload | undefined;
  if (!user?.orgId) return next(Object.assign(new Error('ORG_CONTEXT_MISSING'), { status: 400 }));
  (req as any).ctx = { orgId: user.orgId, branchId: user.branchId || null, role: user.role };
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = (req as any).ctx?.role;
    if (!role || !roles.includes(role)) return next(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    next();
  };
}
