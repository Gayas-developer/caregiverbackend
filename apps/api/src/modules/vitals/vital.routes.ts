import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope } from '../../utils/auth';
import { evaluateThresholdsAndCreateAlertIfNeeded } from '../../services/thresholds';
import { enqueueAlertEmail } from '../../jobs/producers';

export const router = Router();

const vitalSchema = z.object({
  patientId: z.string(),
  visitId: z.string().optional(),
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
    const vital = await prisma.vitalReading.create({
      data: {
        patientId: data.patientId,
        visitId: data.visitId || null,
        type: data.type,
        valueNum: data.valueNum,
        systolic: data.systolic,
        diastolic: data.diastolic,
        unit: data.unit,
        recordedAt: data.recordedAt ? new Date(data.recordedAt) : undefined
      }
    });
    const alert = await evaluateThresholdsAndCreateAlertIfNeeded(vital);
    if (alert) await enqueueAlertEmail(alert);
    res.status(201).json({ data: { vital, alert } });
  } catch (e) { next(e); }
});
