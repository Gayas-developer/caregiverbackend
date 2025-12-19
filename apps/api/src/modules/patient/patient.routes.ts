import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope } from '../../utils/auth';

export const router = Router();

const createPatientSchema = z.object({
  branchId: z.string(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dob: z.string().optional()
});

router.post('/', authenticate, tenantScope, async (req, res, next) => {
  try {
    const data = createPatientSchema.parse(req.body);
    const patient = await prisma.patient.create({
      data: { branchId: data.branchId, firstName: data.firstName, lastName: data.lastName, dob: data.dob ? new Date(data.dob) : null }
    });
    res.status(201).json({ data: patient });
  } catch (e) { next(e); }
});

router.get('/', authenticate, tenantScope, async (req, res, next) => {
  try {
    const { branchId } = (req as any).ctx;
    const list = await prisma.patient.findMany({ where: branchId ? { branchId } : undefined, take: 50, orderBy: { createdAt: 'desc' } });
    res.json({ data: list });
  } catch (e) { next(e); }
});
