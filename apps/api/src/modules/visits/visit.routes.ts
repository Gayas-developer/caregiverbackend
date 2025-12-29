import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';

export const router = Router();

const startVisitSchema = z.object({
  patientId: z.string(),
  startedAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

const updateVisitSchema = z.object({
  notes: z.string().optional(),
  symptoms: z.any().optional(), // stored as JSON
});

router.post('/', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER','CAREGIVER'), async (req, res, next) => {
  try {
    const data = startVisitSchema.parse(req.body);
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };
    const user = (req as any).user as { sub: string };

    const patient = await prisma.patient.findUnique({
      where: { id: data.patientId },
      include: { branch: true }
    });

    if (!patient) return res.status(404).json({ error: { message: 'Patient not found' } });
    if (patient.branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Forbidden' } });
    if (ctx.role === 'CAREGIVER' || ctx.role === 'BRANCH_MANAGER') {
      if (!ctx.branchId) {
        return res.status(403).json({ error: { message: 'Branch context missing' } });
      }
      if (patient.branchId !== ctx.branchId) {
        return res.status(403).json({ error: { message: 'Forbidden' } });
      }
    }
    

    const visit = await prisma.visit.create({
      data: {
        patientId: patient.id,
        branchId: patient.branchId,
        caregiverId: user.sub,
        startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
        notes: data.notes
      }
    });

    res.status(201).json({ data: visit });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id/close', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER','CAREGIVER'), async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };
    const user = (req as any).user as { sub: string };

    const visit = await prisma.visit.findUnique({
      where: { id },
      include: { patient: { include: { branch: true } } }
    });
    if (!visit) return res.status(404).json({ error: { message: 'Visit not found' } });
    if (visit.patient.branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Forbidden' } });
    if (ctx.branchId && visit.branchId !== ctx.branchId) return res.status(403).json({ error: { message: 'Forbidden' } });

    if (ctx.role === 'CAREGIVER' && visit.caregiverId !== user.sub) {
      return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    if (visit.status !== 'OPEN') {
      return res.status(409).json({ error: { message: 'Visit already closed' } });
    }

    const updated = await prisma.visit.update({
      where: { id },
      data: { status: 'CLOSED', endedAt: new Date() }
    });

    res.json({ data: updated });
  } catch (e) {
    next(e);
  }
});

const listSchema = z.object({
  patientId: z.string().optional(),
  branchId: z.string().optional(),
  status: z.enum(['OPEN','CLOSED']).optional()
});

router.get('/', authenticate, tenantScope, async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };
    const q = listSchema.parse(req.query);

    // Default behaviour
    // If token has branchId, lock list to it
    // If token has no branchId (org admin), allow optional branchId filter but enforce org ownership
    let branchId: string | undefined;
    if (ctx.branchId) branchId = ctx.branchId;
    else if (q.branchId) branchId = q.branchId;

    if (branchId && !ctx.branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: branchId } });
      if (!branch || branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    const visits = await prisma.visit.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        ...(q.patientId ? { patientId: q.patientId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            dob: true,
            branchId: true,
          },
        },
        caregiver: {
          select: {
            id: true,
            displayName: true,
            email: true,
            role: true,
            branchId: true,
          },
        },
      },
    });
    

    res.json({ data: visits });
  } catch (e) {
    next(e);
  }
});

router.get('/:id', authenticate, tenantScope, async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };

    const visit = await prisma.visit.findUnique({
      where: { id },
      include: {
        patient: true,
        vitals: { orderBy: { recordedAt: 'asc' } }
      }
    });
    if (!visit) return res.status(404).json({ error: { message: 'Visit not found' } });

    const branch = await prisma.branch.findUnique({ where: { id: visit.branchId } });
    if (!branch || branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Forbidden' } });
    if (ctx.branchId && visit.branchId !== ctx.branchId) return res.status(403).json({ error: { message: 'Forbidden' } });

    res.json({ data: visit });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', authenticate, tenantScope, requireRole('ORG_ADMIN','BRANCH_MANAGER','CAREGIVER'), async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const data = updateVisitSchema.parse(req.body);
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };
    const user = (req as any).user as { sub: string };

    const visit = await prisma.visit.findUnique({
      where: { id },
      include: {
        vitals: { orderBy: { recordedAt: 'desc' } },
        patient: { select: { id: true, firstName: true, lastName: true, dob: true, branchId: true, branch: true } },
        caregiver: { select: { id: true, displayName: true, email: true } },
      },
      // include: { patient: { include: { branch: true } } },
    });

    if (!visit) return res.status(404).json({ error: { message: 'Visit not found' } });
    if (visit.patient.branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Forbidden' } });
    if (ctx.branchId && visit.branchId !== ctx.branchId) return res.status(403).json({ error: { message: 'Forbidden' } });

    if (ctx.role === 'CAREGIVER' && visit.caregiverId !== user.sub) {
      return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    // Optional: only allow editing while OPEN
    if (visit.status !== 'OPEN') {
      return res.status(409).json({ error: { message: 'Visit is closed' } });
    }

    const updated = await prisma.visit.update({
      where: { id },
      data: {
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.symptoms !== undefined ? { symptoms: data.symptoms } : {}),
      },
    });

    res.json({ data: updated });
  } catch (e) {
    next(e);
  }
});