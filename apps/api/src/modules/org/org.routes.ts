import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { publishOrgEvent } from '../../realtime/hub';
import { sendStaffTemporaryPasswordEmail } from '../../utils/mailer';

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
const branchUpdateSchema = z.object({ name: z.string().min(2) });
router.post('/branches', authenticate, tenantScope, requireRole('ORG_ADMIN'), async (req, res, next) => {
  try {
    const data = branchCreateSchema.parse(req.body);
    const user = (req as any).user as { sub: string };
    const dbUser = await prisma.user.findUnique({
      where: { id: user.sub },
      select: { organisationId: true },
    });
    if (!dbUser) return res.status(401).json({ error: { message: 'Unauthorized' } });

    // Use transaction so org lookup and branch create are atomic (avoids FK race).
    const branch = await prisma.$transaction(async (tx) => {
      const org = await tx.organisation.findUnique({
        where: { id: dbUser.organisationId },
        select: { id: true },
      });
      if (!org) {
        throw Object.assign(new Error('Organisation not found for current user'), { status: 400 });
      }
      return tx.branch.create({
        data: { name: data.name, organisationId: org.id },
      });
    });

    publishOrgEvent(dbUser.organisationId, 'BRANCH_CREATED', {
      branch: { id: branch.id, name: branch.name, organisationId: branch.organisationId },
      actorId: user.sub,
    });

    res.status(201).json({ data: branch });
  } catch (e) {
    next(e);
  }
});

router.patch('/branches/:id', authenticate, tenantScope, requireRole('ORG_ADMIN'), async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const data = branchUpdateSchema.parse(req.body);
    const user = (req as any).user as { sub: string };
    const ctx = (req as any).ctx as { orgId: string };

    const branch = await prisma.branch.findUnique({
      where: { id },
      select: { id: true, organisationId: true, name: true },
    });
    if (!branch || branch.organisationId !== ctx.orgId) {
      return res.status(404).json({ error: { message: 'Branch not found' } });
    }

    const updated = await prisma.branch.update({
      where: { id },
      data: { name: data.name },
    });

    publishOrgEvent(ctx.orgId, 'BRANCH_UPDATED', {
      branch: {
        id: updated.id,
        name: updated.name,
        organisationId: updated.organisationId,
      },
      actorId: user.sub,
    });

    res.json({ data: updated });
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
  displayName: z.string().min(2).max(80).optional(),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['ORG_ADMIN','BRANCH_MANAGER','CLINICAL_REVIEWER','CAREGIVER']),
  branchId: z.string().optional()
});

const updateUserSchema = z.object({
  displayName: z.string().min(2).max(80).optional(),
  role: z.enum(['ORG_ADMIN','BRANCH_MANAGER','CLINICAL_REVIEWER','CAREGIVER']).optional(),
  branchId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
}).refine(
  value =>
    value.displayName !== undefined ||
    value.role !== undefined ||
    value.branchId !== undefined ||
    value.isActive !== undefined,
  { message: 'At least one field must be updated' },
);

const setUserPasswordSchema = z.object({
  newPassword: z.string().min(6).optional(),
  sendEmail: z.boolean().optional().default(false),
});

const auditLogQuerySchema = z.object({
  action: z.string().min(1).optional(),
  entity: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

router.get('/audit-logs', authenticate, tenantScope, requireRole('ORG_ADMIN'), async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as { orgId: string };
    const query = auditLogQuerySchema.parse(req.query);

    const logs = await prisma.auditLog.findMany({
      where: {
        orgId: ctx.orgId,
        ...(query.action ? { action: query.action } : {}),
        ...(query.entity ? { entity: query.entity } : {}),
      },
      orderBy: { at: 'desc' },
      take: query.limit,
    });

    const actorIds = Array.from(
      new Set(logs.map(log => log.actorId).filter((value): value is string => Boolean(value))),
    );

    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: {
            id: { in: actorIds },
            organisationId: ctx.orgId,
          },
          select: {
            id: true,
            displayName: true,
            email: true,
            role: true,
          },
        })
      : [];

    const actorMap = new Map(actors.map(actor => [actor.id, actor]));

    res.json({
      data: logs.map(log => ({
        ...log,
        actor: log.actorId ? actorMap.get(log.actorId) || null : null,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/users', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER'), async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };
    const role = typeof req.query.role === 'string' ? req.query.role : undefined;
    const branchIdQuery = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;

    const where: any = {
      organisationId: ctx.orgId,
    };

    if (role) {
      where.role = role;
    }

    if (ctx.role === 'BRANCH_MANAGER') {
      where.branchId = ctx.branchId;
    } else if (branchIdQuery) {
      where.branchId = branchIdQuery;
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        displayName: true,
        email: true,
        isActive: true,
        role: true,
        organisationId: true,
        branchId: true,
        createdAt: true,
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    res.json({ data: users });
  } catch (e) {
    next(e);
  }
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
        displayName: data.displayName,
        email: data.email,
        passwordHash: hash,
        isActive: true,
        role: data.role,
        organisationId: ctx.orgId,
        branchId
      },
      select: {
        id: true,
        displayName: true,
        email: true,
        isActive: true,
        role: true,
        organisationId: true,
        branchId: true,
        createdAt: true,
      }
    });

    res.status(201).json({ data: user });
  } catch (e) {
    next(e);
  }
});

router.patch('/users/:id', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER'), async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const data = updateUserSchema.parse(req.body);
    const user = (req as any).user as { sub: string };
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };

    if (id === user.sub) {
      return res.status(400).json({ error: { message: 'Use your profile screen to update your own account.' } });
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        role: true,
        displayName: true,
        email: true,
        isActive: true,
        organisationId: true,
        branchId: true,
      },
    });
    if (!target || target.organisationId !== ctx.orgId) {
      return res.status(404).json({ error: { message: 'Staff account not found' } });
    }

    if (ctx.role === 'BRANCH_MANAGER') {
      if (target.role !== 'CAREGIVER' || target.branchId !== ctx.branchId) {
        return res.status(403).json({ error: { message: 'You can only manage caregivers in your branch' } });
      }
      if (data.role && data.role !== 'CAREGIVER') {
        return res.status(403).json({ error: { message: 'Branch managers can only manage caregiver accounts' } });
      }
      if (data.branchId !== undefined && data.branchId !== ctx.branchId) {
        return res.status(403).json({ error: { message: 'Caregivers managed by a branch manager must remain in the same branch' } });
      }
    }

    let nextRole = data.role ?? target.role;
    let nextBranchId =
      data.branchId !== undefined ? data.branchId : target.branchId;

    if (ctx.role === 'BRANCH_MANAGER') {
      nextRole = 'CAREGIVER';
      nextBranchId = ctx.branchId;
    }

    if (nextRole === 'ORG_ADMIN') {
      nextBranchId = null;
    }

    if ((nextRole === 'CAREGIVER' || nextRole === 'BRANCH_MANAGER') && !nextBranchId) {
      return res.status(400).json({ error: { message: `${nextRole} must be assigned to a branch` } });
    }

    if (nextBranchId) {
      const branch = await prisma.branch.findUnique({
        where: { id: nextBranchId },
        select: { id: true, organisationId: true },
      });
      if (!branch || branch.organisationId !== ctx.orgId) {
        return res.status(403).json({ error: { message: 'Branch is not in your organisation' } });
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        role: nextRole,
        branchId: nextBranchId,
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
      select: {
        id: true,
        displayName: true,
        email: true,
        isActive: true,
        role: true,
        organisationId: true,
        branchId: true,
        createdAt: true,
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    publishOrgEvent(ctx.orgId, 'STAFF_UPDATED', {
      user: {
        id: updated.id,
        displayName: updated.displayName,
        email: updated.email,
        isActive: updated.isActive,
        role: updated.role,
        branchId: updated.branchId,
      },
      actorId: user.sub,
    }, updated.branchId ? { branchId: updated.branchId } : undefined);

    res.json({ data: updated });
  } catch (e) {
    next(e);
  }
});

router.post('/users/:id/set-password', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER'), async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const data = setUserPasswordSchema.parse(req.body);
    const user = (req as any).user as { sub: string };
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };

    if (id === user.sub) {
      return res.status(400).json({ error: { message: 'Use your profile screen to change your own password.' } });
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        displayName: true,
        email: true,
        role: true,
        organisationId: true,
        branchId: true,
      },
    });
    if (!target || target.organisationId !== ctx.orgId) {
      return res.status(404).json({ error: { message: 'Staff account not found' } });
    }

    if (ctx.role === 'BRANCH_MANAGER') {
      if (target.role !== 'CAREGIVER' || target.branchId !== ctx.branchId) {
        return res.status(403).json({ error: { message: 'You can only manage caregivers in your branch' } });
      }
    }

    const temporaryPassword =
      data.newPassword ||
      crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    await prisma.user.update({
      where: { id },
      data: { passwordHash },
    });

    if (data.sendEmail) {
      await sendStaffTemporaryPasswordEmail({
        to: target.email,
        displayName: target.displayName,
        temporaryPassword,
      });
    }

    publishOrgEvent(ctx.orgId, 'STAFF_PASSWORD_UPDATED', {
      userId: target.id,
      actorId: user.sub,
    }, target.branchId ? { branchId: target.branchId } : undefined);

    res.json({
      data: {
        id: target.id,
        passwordUpdated: true,
        temporaryPassword,
        emailed: data.sendEmail,
      },
    });
  } catch (e) {
    next(e);
  }
});
