import { prisma } from '../utils/prisma';

export async function evaluateThresholdsAndCreateAlertIfNeeded(vital: any) {
  const patient = await prisma.patient.findUnique({
    where: { id: vital.patientId },
    include: { branch: true },
  });

  if (!patient) return null;

  const profiles = await prisma.thresholdProfile.findMany({
    where: { branchId: patient.branchId, type: vital.type },
  });
  if (!profiles.length) return null;

  const prof = profiles[0];
  let breach = false;
  let message = '';

  if (vital.type === 'HEART_RATE' && vital.valueNum != null) {
    if (
      (prof.low != null && vital.valueNum < prof.low) ||
      (prof.high != null && vital.valueNum > prof.high)
    ) {
      breach = true;
      message = `Heart rate ${vital.valueNum} outside [${prof.low ?? '-'}, ${
        prof.high ?? '-'
      }]`;
    }
  }

  if (vital.type === 'TEMPERATURE' && vital.valueNum != null) {
    if (
      (prof.low != null && vital.valueNum < prof.low) ||
      (prof.high != null && vital.valueNum > prof.high)
    ) {
      breach = true;
      message = `Temperature ${vital.valueNum} outside [${prof.low ?? '-'}, ${
        prof.high ?? '-'
      }]`;
    }
  }

  if (
    vital.type === 'BP' &&
    vital.systolic != null &&
    vital.diastolic != null
  ) {
    if (
      (prof.high != null && vital.systolic > prof.high) ||
      (prof.low != null && vital.diastolic < prof.low)
    ) {
      breach = true;
      message = `BP ${vital.systolic}/${
        vital.diastolic
      } outside thresholds (sys>${prof.high ?? '-'} or dia<${prof.low ?? '-'})`;
    }
  }

  if (!breach) return null;

  const alert = await prisma.alert.create({
    data: {
      patientId: vital.patientId,
      branchId: patient.branchId,
      visitId: vital.visitId,
      vitalId: vital.id,
      level: 'WARN',
      message,
      status: 'OPEN',
    },
  });

  return alert;
}
