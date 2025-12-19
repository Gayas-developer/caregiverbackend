import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';

export const router = Router();

const upsertSchema = z.object({
  branchId: z.string(),
  type: z.enum(['HEART_RATE','BP','TEMPERATURE']),
  low: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
});

router.post('/', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER'), async (req, res, next) => {
  try {
    const data = upsertSchema.parse(req.body);
    const record = await prisma.thresholdProfile.upsert({
      where: { branchId_type: { branchId: data.branchId, type: data.type } },
      update: { low: data.low ?? null, high: data.high ?? null },
      create: { branchId: data.branchId, type: data.type, low: data.low ?? null, high: data.high ?? null }
    });
    res.status(201).json({ data: record });
  } catch (e) { next(e); }
});

router.get('/:branchId', authenticate, tenantScope, async (req, res, next) => {
  try {
    const list = await prisma.thresholdProfile.findMany({ where: { branchId: req.params.branchId } });
    res.json({ data: list });
  } catch (e) { next(e); }
});
