import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';
import bcrypt from 'bcrypt';

export const router = Router();

router.get('/me', authenticate, tenantScope, async (req, res, next) => {
  try {
    const user = (req as any).user as { sub: string };
    const dbUser = await prisma.user.findUnique({
      where: { id: user.sub },
      select: { organisationId: true },
    });
    if (!dbUser) return res.status(401).json({ error: { message: 'Unauthorized' } });

    const org = await prisma.organisation.findUnique({
      where: { id: dbUser.organisationId },
      include: { branches: true }
    });
    res.json({ data: org });
  } catch (e) {
    next(e);
  }
});

const branchCreateSchema = z.object({ name: z.string().min(2) });
router.post('/branches', authenticate, tenantScope, requireRole('ORG_ADMIN'), async (req, res, next) => {
  try {
    const data = branchCreateSchema.parse(req.body);
    const user = (req as any).user as { sub: string };
    const dbUser = await prisma.user.findUnique({
      where: { id: user.sub },
      select: { organisationId: true },
    });
    if (!dbUser) return res.status(401).json({ error: { message: 'Unauthorized' } });

    const org = await prisma.organisation.findUnique({
      where: { id: dbUser.organisationId },
      select: { id: true },
    });
    if (!org) {
      return res
        .status(400)
        .json({ error: { message: 'Organisation not found for current user' } });
    }

    const branch = await prisma.branch.create({
      data: { name: data.name, organisationId: org.id },
    });
    res.status(201).json({ data: branch });
  } catch (e) {
    next(e);
  }
});

router.get('/branches', authenticate, tenantScope, requireRole('ORG_ADMIN'), async (req, res, next) => {
  try {
    const user = (req as any).user as { sub: string };
    const dbUser = await prisma.user.findUnique({
      where: { id: user.sub },
      select: { organisationId: true },
    });
    if (!dbUser) return res.status(401).json({ error: { message: 'Unauthorized' } });

    const branches = await prisma.branch.findMany({
      where: { organisationId: dbUser.organisationId },
    });
    res.json({ data: branches });
  } catch (e) { next(e); }
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['ORG_ADMIN','BRANCH_MANAGER','CLINICAL_REVIEWER','CAREGIVER']),
  branchId: z.string().optional()
});

router.post('/users', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER'), async (req, res, next) => {
  try {
    const data = createUserSchema.parse(req.body);
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };

    // Branch managers can only create caregivers in their branch
    let branchId = ctx.branchId || undefined;
    if (ctx.role === 'BRANCH_MANAGER') {
      if (data.role !== 'CAREGIVER') return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    if (!branchId && data.branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: data.branchId } });
      if (!branch || branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Forbidden' } });
      branchId = data.branchId;
    }

    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) return res.status(409).json({ error: { message: 'Email already exists' } });

    const hash = await bcrypt.hash(data.password, 10);
    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash: hash,
        role: data.role,
        organisationId: ctx.orgId,
        branchId
      },
      select: { id: true, email: true, role: true, organisationId: true, branchId: true, createdAt: true }
    });

    res.status(201).json({ data: user });
  } catch (e) {
    next(e);
  }
});
