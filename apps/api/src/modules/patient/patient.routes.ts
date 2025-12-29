import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';

export const router = Router();

const createPatientSchema = z.object({
  branchId: z.string().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dob: z.string().optional(),
});


router.post(
  '/',
  authenticate,
  tenantScope,
  requireRole('ORG_ADMIN', 'BRANCH_MANAGER', 'CAREGIVER'),
  async (req, res, next) => {
    try {
      const data = createPatientSchema.parse(req.body);
      const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };

      let branchIdToUse: string;

      if (ctx.role === 'ORG_ADMIN') {
        if (!data.branchId) {
          return res.status(400).json({ error: { message: 'branchId is required for ORG_ADMIN' } });
        }

        const branch = await prisma.branch.findFirst({
          where: { id: data.branchId, organisationId: ctx.orgId },
          select: { id: true },
        });

        if (!branch) {
          return res.status(403).json({ error: { message: 'Branch not in your organisation' } });
        }

        branchIdToUse = branch.id;
      } else {
        if (!ctx.branchId) {
          return res.status(403).json({ error: { message: 'Branch context missing' } });
        }

        branchIdToUse = ctx.branchId;
      }

      const patient = await prisma.patient.create({
        data: {
          firstName: data.firstName,
          lastName: data.lastName,
          dob: data.dob ? new Date(data.dob) : null,
          branchId: branchIdToUse,
        },
      });

      res.status(201).json({ data: patient });
    } catch (e) {
      next(e);
    }
  }
);


// router.get('/', authenticate, tenantScope, async (req, res, next) => {
//   try {
//     const ctx = (req as any).ctx as { orgId: string; branchId: string | null };
//     const list = await prisma.patient.findMany({
//       where: ctx.branchId
//         ? { branchId: ctx.branchId }
//         : { branch: { organisationId: ctx.orgId } },
//       take: 50,
//       orderBy: { createdAt: 'desc' }
//     });
//     res.json({ data: list });
//   } catch (e) { next(e); }
// });

router.get('/', authenticate, tenantScope, async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };
    const branchIdParam = req.query.branchId as string | undefined;

    // Caregiver + branch roles: hard lock
    if (ctx.role !== 'ORG_ADMIN') {
      const list = await prisma.patient.findMany({
        where: { branchId: ctx.branchId! },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      return res.json({ data: list });
    }

    // ORG_ADMIN: optional branch filter, but validate org ownership
    if (branchIdParam) {
      const branch = await prisma.branch.findFirst({
        where: { id: branchIdParam, organisationId: ctx.orgId },
        select: { id: true },
      });
      if (!branch) return res.status(403).json({ error: { message: 'Branch not in your organisation' } });

      const list = await prisma.patient.findMany({
        where: { branchId: branch.id },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      return res.json({ data: list });
    }

    // ORG_ADMIN default: org-wide
    const list = await prisma.patient.findMany({
      where: { branch: { organisationId: ctx.orgId } },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: list });
  } catch (e) { next(e); }
});

