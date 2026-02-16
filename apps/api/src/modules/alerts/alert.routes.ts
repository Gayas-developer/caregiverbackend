import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope, requireRole } from '../../utils/auth';
import { publishOrgEvent } from '../../realtime/hub';

export const router = Router();

const listSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  branchId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});

router.get('/', authenticate, tenantScope, async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as {
      orgId: string;
      branchId: string | null;
      role: string;
    };
    const q = listSchema.parse(req.query);

    let allowedBranchIds: string[] = [];

    if (ctx.role !== 'ORG_ADMIN') {
      if (!ctx.branchId) {
        return res.status(403).json({
          error: { message: 'Branch context missing. Please contact admin.' },
        });
      }
      allowedBranchIds = [ctx.branchId];
    } else if (q.branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: q.branchId } });
      if (!branch || branch.organisationId !== ctx.orgId) {
        return res
          .status(403)
          .json({ error: { message: 'Branch is not in your organisation' } });
      }
      allowedBranchIds = [q.branchId];
    } else {
      const branches = await prisma.branch.findMany({
        where: { organisationId: ctx.orgId },
        select: { id: true },
      });
      allowedBranchIds = branches.map(b => b.id);
    }

    if (!allowedBranchIds.length) {
      return res.json({ data: [] });
    }

    const alerts = await prisma.alert.findMany({
      where: {
        branchId: { in: allowedBranchIds },
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit || 50,
      include: {
        actions: {
          orderBy: { timestamp: 'desc' },
          take: 10,
        },
      },
    });

    const patientIds = [...new Set(alerts.map(a => a.patientId))];
    const visitIds = [...new Set(alerts.map(a => a.visitId))];
    const actorIds = [
      ...new Set(alerts.flatMap(a => a.actions.map(act => act.actorId).filter(Boolean))),
    ] as string[];

    const [patients, visits, actors] = await Promise.all([
      patientIds.length
        ? prisma.patient.findMany({
            where: { id: { in: patientIds } },
            select: { id: true, firstName: true, lastName: true, dob: true },
          })
        : Promise.resolve([]),
      visitIds.length
        ? prisma.visit.findMany({
            where: { id: { in: visitIds } },
            select: {
              id: true,
              status: true,
              startedAt: true,
              endedAt: true,
              caregiverId: true,
            },
          })
        : Promise.resolve([]),
      actorIds.length
        ? prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, displayName: true, email: true },
          })
        : Promise.resolve([]),
    ]);

    const patientById = new Map(patients.map(p => [p.id, p]));
    const visitById = new Map(visits.map(v => [v.id, v]));
    const actorById = new Map(actors.map(a => [a.id, a]));

    const data = alerts.map(alert => ({
      ...alert,
      patient: patientById.get(alert.patientId) || null,
      visit: visitById.get(alert.visitId) || null,
      actions: alert.actions.map(action => ({
        ...action,
        actor: action.actorId ? actorById.get(action.actorId) || null : null,
      })),
    }));

    res.json({ data });
  } catch (e) {
    next(e);
  }
});

const addActionSchema = z.object({
  action: z.string().min(2).max(120),
  closeAlert: z.boolean().optional(),
});

router.post(
  '/:id/actions',
  authenticate,
  tenantScope,
  requireRole('ORG_ADMIN', 'BRANCH_MANAGER', 'CAREGIVER', 'CLINICAL_REVIEWER'),
  async (req, res, next) => {
    try {
      const id = z.string().parse(req.params.id);
      const data = addActionSchema.parse(req.body);
      const user = (req as any).user as { sub: string };
      const ctx = (req as any).ctx as {
        orgId: string;
        branchId: string | null;
        role: string;
      };

      const alert = await prisma.alert.findUnique({ where: { id } });
      if (!alert) return res.status(404).json({ error: { message: 'Alert not found' } });

      const branch = await prisma.branch.findUnique({
        where: { id: alert.branchId },
        select: { id: true, organisationId: true },
      });
      if (!branch || branch.organisationId !== ctx.orgId) {
        return res
          .status(403)
          .json({ error: { message: 'Alert is not in your organisation' } });
      }
      if (ctx.role !== 'ORG_ADMIN' && ctx.branchId && ctx.branchId !== alert.branchId) {
        return res
          .status(403)
          .json({ error: { message: 'You can only manage alerts in your branch' } });
      }

      const result = await prisma.$transaction(async tx => {
        const action = await tx.escalationAction.create({
          data: {
            alertId: alert.id,
            actorId: user.sub,
            action: data.action,
          },
        });

        const updatedAlert = await tx.alert.update({
          where: { id: alert.id },
          data: data.closeAlert ? { status: 'CLOSED' } : {},
        });

        return { action, alert: updatedAlert };
      });

      publishOrgEvent(
        ctx.orgId,
        'ALERT_UPDATED',
        {
          alertId: result.alert.id,
          status: result.alert.status,
          action: {
            id: result.action.id,
            action: result.action.action,
            actorId: result.action.actorId,
            timestamp: result.action.timestamp,
          },
        },
        { branchId: result.alert.branchId },
      );

      res.status(201).json({ data: result });
    } catch (e) {
      next(e);
    }
  },
);
