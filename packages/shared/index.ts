export type Role = 'ORG_ADMIN' | 'BRANCH_MANAGER' | 'CLINICAL_REVIEWER' | 'CAREGIVER';

export const Roles = {
  ORG_ADMIN: 'ORG_ADMIN',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  CLINICAL_REVIEWER: 'CLINICAL_REVIEWER',
  CAREGIVER: 'CAREGIVER',
} as const;

export type VitalType = 'HEART_RATE' | 'BP' | 'TEMPERATURE';

export const VitalTypes = {
  HEART_RATE: 'HEART_RATE',
  BP: 'BP',
  TEMPERATURE: 'TEMPERATURE',
} as const;
