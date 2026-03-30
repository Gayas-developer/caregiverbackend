import bcrypt from 'bcrypt';

import { prisma } from './prisma';

const DEFAULT_PLATFORM_ADMIN_EMAIL = 'myhomecare@myhomecare.com';
const DEFAULT_PLATFORM_ADMIN_PASSWORD = 'Myhomecare123@';
const DEFAULT_PLATFORM_ORG_NAME = 'My Homecare Platform';
const DEFAULT_PLATFORM_ORG_SLUG = 'myhomecare-platform';

export function getPlatformAdminConfig() {
  return {
    email: (process.env.PLATFORM_ADMIN_EMAIL || DEFAULT_PLATFORM_ADMIN_EMAIL)
      .trim()
      .toLowerCase(),
    password: process.env.PLATFORM_ADMIN_PASSWORD || DEFAULT_PLATFORM_ADMIN_PASSWORD,
    organisationName:
      process.env.PLATFORM_ORG_NAME || DEFAULT_PLATFORM_ORG_NAME,
    organisationSlug:
      process.env.PLATFORM_ORG_SLUG || DEFAULT_PLATFORM_ORG_SLUG,
  };
}

export function isPlatformAdminEmail(email: string) {
  return email.trim().toLowerCase() === getPlatformAdminConfig().email;
}

export async function ensurePlatformAdminAccount() {
  const config = getPlatformAdminConfig();
  const passwordHash = await bcrypt.hash(config.password, 10);

  const organisation = await prisma.organisation.upsert({
    where: { slug: config.organisationSlug },
    update: {
      name: config.organisationName,
      isActive: true,
    },
    create: {
      name: config.organisationName,
      slug: config.organisationSlug,
      isActive: true,
    },
  });

  const user = await prisma.user.upsert({
    where: { email: config.email },
    update: {
      displayName: 'My Homecare Admin',
      passwordHash,
      isActive: true,
      role: 'PLATFORM_ADMIN',
      organisationId: organisation.id,
      branchId: null,
    },
    create: {
      displayName: 'My Homecare Admin',
      email: config.email,
      passwordHash,
      isActive: true,
      role: 'PLATFORM_ADMIN',
      organisationId: organisation.id,
      branchId: null,
    },
  });

  return { organisation, user };
}
