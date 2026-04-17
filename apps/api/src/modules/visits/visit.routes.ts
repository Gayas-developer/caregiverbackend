import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';
import { publishOrgEvent } from '../../realtime/hub';

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
    if (patient.archivedAt) {
      return res.status(409).json({
        error: { message: 'This patient has been archived and cannot start a new visit.' },
      });
    }
    if (patient.branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Patient is not in your organisation' } });
    if (ctx.role === 'CAREGIVER' || ctx.role === 'BRANCH_MANAGER') {
      if (!ctx.branchId) {
        return res.status(403).json({ error: { message: 'Branch context missing. Please contact admin.' } });
      }
      if (patient.branchId !== ctx.branchId) {
        return res.status(403).json({ error: { message: 'You can only start visits for patients in your branch' } });
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

    publishOrgEvent(
      ctx.orgId,
      'VISIT_STARTED',
      {
        visit: {
          id: visit.id,
          patientId: visit.patientId,
          branchId: visit.branchId,
          caregiverId: visit.caregiverId,
          status: visit.status,
          startedAt: visit.startedAt,
        },
        actorId: user.sub,
      },
      { branchId: visit.branchId },
    );

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
    if (visit.patient.branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Visit is not in your organisation' } });
    if (ctx.role !== 'ORG_ADMIN' && ctx.branchId && visit.branchId !== ctx.branchId) return res.status(403).json({ error: { message: 'You can only access visits in your branch' } });

    if (ctx.role === 'CAREGIVER' && visit.caregiverId !== user.sub) {
      return res.status(403).json({ error: { message: 'You can only close your own visits' } });
    }

    if (visit.status !== 'OPEN') {
      return res.status(409).json({ error: { message: 'Visit already closed' } });
    }

    const updated = await prisma.visit.update({
      where: { id },
      data: { status: 'CLOSED', endedAt: new Date() }
    });

    publishOrgEvent(
      ctx.orgId,
      'VISIT_CLOSED',
      {
        visit: {
          id: updated.id,
          patientId: updated.patientId,
          branchId: updated.branchId,
          caregiverId: updated.caregiverId,
          status: updated.status,
          endedAt: updated.endedAt,
        },
        actorId: user.sub,
      },
      { branchId: updated.branchId },
    );

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

    let branchId: string | undefined;
    const roleCanViewOrgWide =
      ctx.role === 'ORG_ADMIN' || ctx.role === 'CLINICAL_REVIEWER';

    if (q.branchId) {
      branchId = q.branchId;
    } else if (!roleCanViewOrgWide) {
      if (!ctx.branchId) {
        return res.status(403).json({ error: { message: 'Branch context missing. Please contact admin.' } });
      }
      branchId = ctx.branchId;
    } else if (ctx.role === 'CLINICAL_REVIEWER' && ctx.branchId) {
      branchId = ctx.branchId;
    }

    if (branchId && roleCanViewOrgWide) {
      const branch = await prisma.branch.findUnique({ where: { id: branchId } });
      if (!branch || branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Branch is not in your organisation' } });
    }

    const visits = await prisma.visit.findMany({
      where: {
        branch: { organisationId: ctx.orgId },
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
    if (!branch || branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Visit is not in your organisation' } });
    if (ctx.role !== 'ORG_ADMIN' && ctx.branchId && visit.branchId !== ctx.branchId) return res.status(403).json({ error: { message: 'You can only access visits in your branch' } });

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
    if (visit.patient.branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Visit is not in your organisation' } });
    if (ctx.role !== 'ORG_ADMIN' && ctx.branchId && visit.branchId !== ctx.branchId) return res.status(403).json({ error: { message: 'You can only access visits in your branch' } });

    if (ctx.role === 'CAREGIVER' && visit.caregiverId !== user.sub) {
      return res.status(403).json({ error: { message: 'You can only edit your own visits' } });
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
