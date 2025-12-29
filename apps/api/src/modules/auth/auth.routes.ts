import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { prisma } from '../../utils/prisma';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/auth';

export const router = Router();

const registerSchema = z.object({
  displayName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  organisation: z.object({ name: z.string().min(2), slug: z.string().min(2) }),
  branch: z.object({ name: z.string().min(2) }).optional()
});

router.post('/register', async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) return res.status(409).json({ error: { message: 'Email already exists' } });

    const slugExists = await prisma.organisation.findUnique({ where: { slug: data.organisation.slug } });
    if (slugExists) return res.status(409).json({ error: { message: 'Organisation slug already exists' } });

    const hash = await bcrypt.hash(data.password, 10);

    const org = await prisma.organisation.create({ data: { name: data.organisation.name, slug: data.organisation.slug } });
    const branch = await prisma.branch.create({ data: { name: data.branch?.name || 'Main', organisationId: org.id } });
    const user = await prisma.user.create({
      data: { displayName: data.displayName, email: data.email, passwordHash: hash, role: 'ORG_ADMIN', organisationId: org.id, branchId: branch.id }
    });

    const access = signAccessToken({ sub: user.id, orgId: org.id, branchId: branch.id, role: user.role });
    const refresh = signRefreshToken({ sub: user.id, orgId: org.id, branchId: branch.id, role: user.role });
    res.status(201).json({ data: { user: { id: user.id, email: user.email, role: user.role }, tokens: { access, refresh } } });
  } catch (e) { next(e); }
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: { message: 'Invalid credentials' } });
    if ((user.role === 'CAREGIVER' || user.role === 'BRANCH_MANAGER') && !user.branchId) {
      return res.status(403).json({ error: { message: 'User is not assigned to a branch' } });
    }    
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: { message: 'Invalid credentials' } });

    const access = signAccessToken({ sub: user.id, orgId: user.organisationId, branchId: user.branchId || null, role: user.role });
    const refresh = signRefreshToken({ sub: user.id, orgId: user.organisationId, branchId: user.branchId || null, role: user.role });
    res.json({ data: { user: { id: user.id, email: user.email, role: user.role }, tokens: { access, refresh } } });
  } catch (e) { next(e); }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh } = z.object({ refresh: z.string().min(1) }).parse(req.body);
    const payload = verifyRefreshToken(refresh);

    const revoked = await prisma.revokedToken.findUnique({ where: { jti: payload.jti } });
    if (revoked) return res.status(401).json({ error: { message: 'Refresh token revoked' } });

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: { message: 'User not found' } });

    const access = signAccessToken({ sub: user.id, orgId: user.organisationId, branchId: user.branchId || null, role: user.role });
    const newRefresh = signRefreshToken({ sub: user.id, orgId: user.organisationId, branchId: user.branchId || null, role: user.role });

    await prisma.revokedToken.create({ data: { jti: payload.jti, type: 'refresh', expiresAt: new Date(Date.now() + 7*24*3600*1000) } });
    res.json({ data: { tokens: { access, refresh: newRefresh } } });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const { token, type } = z.object({ token: z.string().min(1), type: z.enum(['access','refresh']) }).parse(req.body);
    const secret = type === 'refresh' ? process.env.JWT_REFRESH_SECRET! : process.env.JWT_ACCESS_SECRET!;
    const payload = jwt.verify(token, secret) as any;
    const expSec = Math.max(0, (payload.exp ?? 0) - Math.floor(Date.now()/1000));
    await prisma.revokedToken.create({ data: { jti: payload.jti, type, expiresAt: new Date(Date.now() + expSec*1000) } });
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
});
