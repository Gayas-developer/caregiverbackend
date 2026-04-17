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

const archivePatientSchema = z.object({
  archived: z.boolean().default(true),
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
            archivedAt: null,
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
    const roleCanViewOrgWide =
      ctx.role === 'ORG_ADMIN' || ctx.role === 'CLINICAL_REVIEWER';

    // Caregiver + branch roles: hard lock
    if (!roleCanViewOrgWide) {
      if (!ctx.branchId) {
        return res.status(403).json({ error: { message: 'Branch context missing. Please contact admin.' } });
      }
      const list = await prisma.patient.findMany({
        where: { branchId: ctx.branchId!, archivedAt: null },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      return res.json({ data: list });
    }

    // ORG_ADMIN / org-wide reviewer: optional branch filter, but validate org ownership
    if (branchIdParam) {
      const branch = await prisma.branch.findFirst({
        where: { id: branchIdParam, organisationId: ctx.orgId },
        select: { id: true },
      });
      if (!branch) return res.status(403).json({ error: { message: 'Branch not in your organisation' } });

      const list = await prisma.patient.findMany({
        where: { branchId: branch.id, archivedAt: null },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      return res.json({ data: list });
    }

    if (ctx.role === 'CLINICAL_REVIEWER' && ctx.branchId) {
      const list = await prisma.patient.findMany({
        where: { branchId: ctx.branchId, archivedAt: null },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      return res.json({ data: list });
    }

    // ORG_ADMIN default: org-wide
    const list = await prisma.patient.findMany({
      where: { branch: { organisationId: ctx.orgId }, archivedAt: null },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: list });
  } catch (e) { next(e); }
});

router.patch(
  '/:id/archive',
  authenticate,
  tenantScope,
  requireRole('ORG_ADMIN', 'BRANCH_MANAGER'),
  async (req, res, next) => {
    try {
      const id = z.string().parse(req.params.id);
      const data = archivePatientSchema.parse(req.body ?? {});
      const ctx = (req as any).ctx as {
        orgId: string;
        branchId: string | null;
        role: string;
      };
      const user = (req as any).user as { sub: string };

      const patient = await prisma.patient.findFirst({
        where: {
          id,
          branch: { organisationId: ctx.orgId },
        },
        include: {
          branch: { select: { id: true, name: true } },
          visits: {
            where: { status: 'OPEN' },
            select: { id: true },
            take: 1,
          },
        },
      });

      if (!patient) {
        return res.status(404).json({ error: { message: 'Patient not found' } });
      }

      if (ctx.role === 'BRANCH_MANAGER') {
        if (!ctx.branchId || patient.branchId !== ctx.branchId) {
          return res
            .status(403)
            .json({ error: { message: 'You can only manage patients in your branch.' } });
        }
      }

      if (patient.visits.length && data.archived) {
        return res.status(409).json({
          error: { message: 'Close the open visit before archiving this patient.' },
        });
      }

      const archivedAt = data.archived ? new Date() : null;
      const updated = await prisma.patient.update({
        where: { id: patient.id },
        data: { archivedAt },
      });

      publishOrgEvent(
        ctx.orgId,
        data.archived ? 'PATIENT_ARCHIVED' : 'PATIENT_RESTORED',
        {
          patient: {
            id: updated.id,
            firstName: updated.firstName,
            lastName: updated.lastName,
            branchId: updated.branchId,
            archivedAt: updated.archivedAt,
          },
          actorId: user.sub,
        },
        { branchId: updated.branchId },
      );

      res.json({ data: updated });
    } catch (e) {
      next(e);
    }
  },
);
