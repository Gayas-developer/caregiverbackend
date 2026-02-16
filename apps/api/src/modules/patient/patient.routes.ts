import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';
import { publishOrgEvent } from '../../realtime/hub';

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
      const user = (req as any).user as { sub: string };

      const branchIdToLookup =
        ctx.role === 'ORG_ADMIN'
          ? data.branchId
          : ctx.branchId;

      if (ctx.role === 'ORG_ADMIN' && !data.branchId) {
        return res.status(400).json({ error: { message: 'Please select a branch for this patient.' } });
      }
      if (ctx.role !== 'ORG_ADMIN' && !ctx.branchId) {
        return res.status(403).json({ error: { message: 'Branch context missing. Please contact admin.' } });
      }

      // Use a transaction so branch validation and patient create are atomic (avoids FK race).
      const patient = await prisma.$transaction(async (tx) => {
        const branch = await tx.branch.findFirst({
          where: { id: branchIdToLookup!, organisationId: ctx.orgId },
          select: { id: true },
        });
        if (!branch) {
          if (ctx.role === 'ORG_ADMIN') {
            throw Object.assign(new Error('Branch not found or not in your organisation.'), { status: 403 });
          }
          throw Object.assign(new Error('Invalid branch assignment. Please contact admin.'), { status: 403 });
        }
        return tx.patient.create({
          data: {
            firstName: data.firstName,
            lastName: data.lastName,
            dob: data.dob ? new Date(data.dob) : null,
            branchId: branch.id,
          },
        });
      });

      publishOrgEvent(
        ctx.orgId,
        'PATIENT_CREATED',
        {
          patient: {
            id: patient.id,
            firstName: patient.firstName,
            lastName: patient.lastName,
            branchId: patient.branchId,
            createdAt: patient.createdAt,
          },
          actorId: user.sub,
        },
        { branchId: patient.branchId },
      );

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
