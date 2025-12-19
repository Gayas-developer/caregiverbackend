import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';

export const router = Router();

const orgCreateSchema = z.object({ name: z.string().min(2), slug: z.string().min(2) });
router.post('/', authenticate, tenantScope, requireRole('ORG_ADMIN'), async (req, res, next) => {
  try {
    const data = orgCreateSchema.parse(req.body);
    const org = await prisma.organisation.create({ data });
    res.status(201).json({ data: org });
  } catch (e) { next(e); }
});

const branchCreateSchema = z.object({ name: z.string().min(2), organisationId: z.string().cuid() });
router.post('/branches', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER'), async (req, res, next) => {
  try {
    const data = branchCreateSchema.parse(req.body);
    const branch = await prisma.branch.create({ data });
    res.status(201).json({ data: branch });
  } catch (e) { next(e); }
});
