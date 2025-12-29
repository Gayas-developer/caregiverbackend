import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';

export const router = Router();

const upsertSchema = z.object({
  branchId: z.string().optional(),
  type: z.enum(['HEART_RATE','BP','TEMPERATURE']),
  low: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
});

router.post('/', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER'), async (req, res, next) => {
  try {
    const data = upsertSchema.parse(req.body);
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };

    // Branch managers are locked to their branch
    let branchId = ctx.branchId || undefined;
    if (!branchId) {
      if (!data.branchId) return res.status(400).json({ error: { message: 'branchId is required' } });
      const branch = await prisma.branch.findUnique({ where: { id: data.branchId } });
      if (!branch || branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Forbidden' } });
      branchId = data.branchId;
    }

    const record = await prisma.thresholdProfile.upsert({
      where: { branchId_type: { branchId, type: data.type } },
      update: { low: data.low ?? null, high: data.high ?? null },
      create: { branchId, type: data.type, low: data.low ?? null, high: data.high ?? null }
    });
    res.status(201).json({ data: record });
  } catch (e) { next(e); }
});

router.get('/:branchId', authenticate, tenantScope, async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };
    const branchId = req.params.branchId;

    if (ctx.branchId && branchId !== ctx.branchId) return res.status(403).json({ error: { message: 'Forbidden' } });
    if (!ctx.branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: branchId } });
      if (!branch || branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    const list = await prisma.thresholdProfile.findMany({ where: { branchId } });
    res.json({ data: list });
  } catch (e) { next(e); }
});
