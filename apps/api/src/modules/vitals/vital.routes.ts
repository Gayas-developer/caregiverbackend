import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope } from '../../utils/auth';
import { evaluateThresholdsAndCreateAlertIfNeeded } from '../../services/thresholds';
import { enqueueAlertEmail } from '../../jobs/producers';
import { publishOrgEvent } from '../../realtime/hub';

export const router = Router();

const vitalSchema = z.object({
  visitId: z.string(),
  type: z.enum(['HEART_RATE','BP','TEMPERATURE']),
  valueNum: z.number().optional(),
  systolic: z.number().int().optional(),
  diastolic: z.number().int().optional(),
  unit: z.string().optional(),
  recordedAt: z.string().datetime().optional()
});

router.post('/', authenticate, tenantScope, async (req, res, next) => {
  try {
    const data = vitalSchema.parse(req.body);
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null; role: string };
    const user = (req as any).user as { sub: string };

    const visit = await prisma.visit.findUnique({
      where: { id: data.visitId },
      include: { patient: { include: { branch: true } } }
    });
    if (!visit) return res.status(404).json({ error: { message: 'Visit not found' } });
    if (visit.patient.branch.organisationId !== ctx.orgId) return res.status(403).json({ error: { message: 'Visit is not in your organisation' } });
    if (ctx.role !== 'ORG_ADMIN' && ctx.branchId && visit.branchId !== ctx.branchId) {
      return res.status(403).json({ error: { message: 'You can only access visits in your branch' } });
    }
    if (visit.status !== 'OPEN') return res.status(409).json({ error: { message: 'Visit is closed' } });

    // For caregivers, enforce that they can only record vitals on visits they own
    if (ctx.role === 'CAREGIVER' && visit.caregiverId !== user.sub) {
      return res.status(403).json({ error: { message: 'You can only record vitals for your own visits' } });
    }

    const vital = await prisma.vitalReading.create({
      data: {
        patientId: visit.patientId,
        visitId: data.visitId,
        type: data.type,
        valueNum: data.valueNum,
        systolic: data.systolic,
        diastolic: data.diastolic,
        unit: data.unit,
        recordedAt: data.recordedAt ? new Date(data.recordedAt) : undefined
      }
    });

    publishOrgEvent(
      ctx.orgId,
      'VITAL_RECORDED',
      {
        vital: {
          id: vital.id,
          patientId: vital.patientId,
          visitId: vital.visitId,
          type: vital.type,
          valueNum: vital.valueNum,
          systolic: vital.systolic,
          diastolic: vital.diastolic,
          unit: vital.unit,
          recordedAt: vital.recordedAt,
        },
      },
      { branchId: visit.branchId },
    );

    const alert = await evaluateThresholdsAndCreateAlertIfNeeded(vital);
    if (alert) {
      await enqueueAlertEmail(alert);
      publishOrgEvent(
        ctx.orgId,
        'ALERT_CREATED',
        {
          alert: {
            id: alert.id,
            patientId: alert.patientId,
            visitId: alert.visitId,
            branchId: alert.branchId,
            level: alert.level,
            message: alert.message,
            status: alert.status,
            createdAt: alert.createdAt,
          },
        },
        { branchId: alert.branchId },
      );
    }
    res.status(201).json({ data: { vital, alert } });
  } catch (e) { next(e); }
});
