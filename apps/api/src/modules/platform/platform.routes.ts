import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

import { authenticate, tenantScope, requireRole } from '../../utils/auth';
import { prisma } from '../../utils/prisma';
import { getPlatformAdminConfig } from '../../utils/platformAdmin';
import { sendStaffTemporaryPasswordEmail } from '../../utils/mailer';

export const router = Router();

router.use(authenticate, tenantScope, requireRole('PLATFORM_ADMIN'));

const platformOrgSlug = getPlatformAdminConfig().organisationSlug;

const organisationCreateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2),
  initialBranchName: z.string().min(2).optional(),
});

const organisationUpdateSchema = z
  .object({
    name: z.string().min(2).optional(),
    slug: z.string().min(2).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    value =>
      value.name !== undefined ||
      value.slug !== undefined ||
      value.isActive !== undefined,
    { message: 'At least one field must be updated' },
  );

const orgAdminCreateSchema = z.object({
  organisationId: z.string().min(1),
  displayName: z.string().min(2).max(80).optional(),
  email: z.string().email(),
  password: z.string().min(6),
  isActive: z.boolean().optional().default(true),
});

const orgAdminUpdateSchema = z
  .object({
    organisationId: z.string().min(1).optional(),
    displayName: z.string().min(2).max(80).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    value =>
      value.organisationId !== undefined ||
      value.displayName !== undefined ||
      value.isActive !== undefined,
    { message: 'At least one field must be updated' },
  );

const setPasswordSchema = z.object({
  newPassword: z.string().min(6).optional(),
  sendEmail: z.boolean().optional().default(false),
});

const visitListSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  organisationId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

const alertQuerySchema = z.object({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

const auditQuerySchema = z.object({
  action: z.string().min(1).optional(),
  entity: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

async function listManagedOrganisations() {
  return prisma.organisation.findMany({
    where: {
      slug: { not: platformOrgSlug },
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function assertManagedOrganisation(organisationId: string) {
  const organisation = await prisma.organisation.findFirst({
    where: {
      id: organisationId,
      slug: { not: platformOrgSlug },
    },
  });

  if (!organisation) {
    throw Object.assign(new Error('Organisation not found'), { status: 404 });
  }

  return organisation;
}

router.get('/overview', async (_req, res, next) => {
  try {
    const organisations = await listManagedOrganisations();
    const organisationIds = organisations.map(organisation => organisation.id);
    const branches = await prisma.branch.findMany({
      where: { organisationId: { in: organisationIds } },
      select: { id: true },
    });
    const branchIds = branches.map(branch => branch.id);

    const [
      orgAdmins,
      patients,
      visits,
      openVisits,
      alerts,
      openAlerts,
    ] = await Promise.all([
      prisma.user.count({
        where: {
          role: 'ORG_ADMIN',
          organisationId: { in: organisationIds },
        },
      }),
      prisma.patient.count({
        where: { branchId: { in: branchIds } },
      }),
      prisma.visit.count({
        where: { branchId: { in: branchIds } },
      }),
      prisma.visit.count({
        where: {
          branchId: { in: branchIds },
          status: 'OPEN',
        },
      }),
      prisma.alert.count({
        where: { branchId: { in: branchIds } },
      }),
      prisma.alert.count({
        where: {
          branchId: { in: branchIds },
          status: 'OPEN',
        },
      }),
    ]);

    res.json({
      data: {
        organisations: organisations.length,
        inactiveOrganisations: organisations.filter(org => !org.isActive).length,
        branches: branches.length,
        orgAdmins,
        patients,
        visits,
        openVisits,
        alerts,
        openAlerts,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.get('/organisations', async (_req, res, next) => {
  try {
    const [organisations, adminCounts] = await Promise.all([
      prisma.organisation.findMany({
        where: { slug: { not: platformOrgSlug } },
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              branches: true,
              users: true,
            },
          },
        },
      }),
      prisma.user.groupBy({
        by: ['organisationId'],
        where: {
          role: 'ORG_ADMIN',
          organisation: { slug: { not: platformOrgSlug } },
        },
        _count: { _all: true },
      }),
    ]);

    const adminCountMap = new Map(
      adminCounts.map(item => [item.organisationId, item._count._all]),
    );

    res.json({
      data: organisations.map(organisation => ({
        ...organisation,
        orgAdminCount: adminCountMap.get(organisation.id) || 0,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/organisations', async (req, res, next) => {
  try {
    const data = organisationCreateSchema.parse(req.body);

    const slugExists = await prisma.organisation.findUnique({
      where: { slug: data.slug },
      select: { id: true },
    });
    if (slugExists) {
      return res
        .status(409)
        .json({ error: { message: 'Organisation slug already exists' } });
    }

    const organisation = await prisma.$transaction(async tx => {
      const created = await tx.organisation.create({
        data: {
          name: data.name,
          slug: data.slug,
          isActive: true,
        },
      });

      await tx.branch.create({
        data: {
          name: data.initialBranchName || 'Main',
          organisationId: created.id,
        },
      });

      return created;
    });

    res.status(201).json({ data: organisation });
  } catch (e) {
    next(e);
  }
});

router.patch('/organisations/:id', async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const data = organisationUpdateSchema.parse(req.body);

    await assertManagedOrganisation(id);

    if (data.slug) {
      const slugExists = await prisma.organisation.findFirst({
        where: {
          slug: data.slug,
          id: { not: id },
        },
        select: { id: true },
      });
      if (slugExists) {
        return res
          .status(409)
          .json({ error: { message: 'Organisation slug already exists' } });
      }
    }

    const organisation = await prisma.organisation.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.slug !== undefined ? { slug: data.slug } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    res.json({ data: organisation });
  } catch (e) {
    next(e);
  }
});

router.get('/org-admins', async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        role: 'ORG_ADMIN',
        organisation: { slug: { not: platformOrgSlug } },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        displayName: true,
        email: true,
        isActive: true,
        role: true,
        organisationId: true,
        branchId: true,
        createdAt: true,
        organisation: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
        },
      },
    });

    res.json({ data: users });
  } catch (e) {
    next(e);
  }
});

router.post('/org-admins', async (req, res, next) => {
  try {
    const data = orgAdminCreateSchema.parse(req.body);
    await assertManagedOrganisation(data.organisationId);

    const normalizedEmail = data.email.trim().toLowerCase();
    const exists = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (exists) {
      return res.status(409).json({ error: { message: 'Email already exists' } });
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const user = await prisma.user.create({
      data: {
        displayName: data.displayName,
        email: normalizedEmail,
        passwordHash,
        isActive: data.isActive,
        role: 'ORG_ADMIN',
        organisationId: data.organisationId,
        branchId: null,
      },
      select: {
        id: true,
        displayName: true,
        email: true,
        isActive: true,
        role: true,
        organisationId: true,
        branchId: true,
        createdAt: true,
        organisation: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
        },
      },
    });

    res.status(201).json({ data: user });
  } catch (e) {
    next(e);
  }
});

router.patch('/org-admins/:id', async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const data = orgAdminUpdateSchema.parse(req.body);

    const target = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        role: true,
        organisationId: true,
      },
    });

    if (!target || target.role !== 'ORG_ADMIN') {
      return res
        .status(404)
        .json({ error: { message: 'Organisation admin not found' } });
    }

    const nextOrganisationId = data.organisationId || target.organisationId;
    await assertManagedOrganisation(nextOrganisationId);

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(data.displayName !== undefined
          ? { displayName: data.displayName }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        organisationId: nextOrganisationId,
        branchId: null,
        role: 'ORG_ADMIN',
      },
      select: {
        id: true,
        displayName: true,
        email: true,
        isActive: true,
        role: true,
        organisationId: true,
        branchId: true,
        createdAt: true,
        organisation: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
        },
      },
    });

    res.json({ data: user });
  } catch (e) {
    next(e);
  }
});

router.post('/org-admins/:id/set-password', async (req, res, next) => {
  try {
    const id = z.string().parse(req.params.id);
    const data = setPasswordSchema.parse(req.body);

    const target = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        displayName: true,
        email: true,
        role: true,
        organisationId: true,
      },
    });
    if (!target || target.role !== 'ORG_ADMIN') {
      return res
        .status(404)
        .json({ error: { message: 'Organisation admin not found' } });
    }

    await assertManagedOrganisation(target.organisationId);

    const temporaryPassword =
      data.newPassword ||
      crypto
        .randomBytes(9)
        .toString('base64url')
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 12);
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    await prisma.user.update({
      where: { id },
      data: { passwordHash },
    });

    if (data.sendEmail) {
      await sendStaffTemporaryPasswordEmail({
        to: target.email,
        displayName: target.displayName,
        temporaryPassword,
      });
    }

    res.json({
      data: {
        id: target.id,
        passwordUpdated: true,
        temporaryPassword,
        emailed: data.sendEmail,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.get('/patients', async (_req, res, next) => {
  try {
    const patients = await prisma.patient.findMany({
      where: {
        branch: { organisation: { slug: { not: platformOrgSlug } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        branch: {
          select: {
            id: true,
            name: true,
            organisation: {
              select: {
                id: true,
                name: true,
                slug: true,
                isActive: true,
              },
            },
          },
        },
      },
    });

    res.json({ data: patients });
  } catch (e) {
    next(e);
  }
});

router.get('/visits', async (req, res, next) => {
  try {
    const q = visitListSchema.parse(req.query);

    const visits = await prisma.visit.findMany({
      where: {
        branch: {
          organisation: {
            slug: { not: platformOrgSlug },
            ...(q.organisationId ? { id: q.organisationId } : {}),
          },
        },
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: q.limit,
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
        branch: {
          select: {
            id: true,
            name: true,
            organisation: {
              select: {
                id: true,
                name: true,
                slug: true,
                isActive: true,
              },
            },
          },
        },
      },
    });

    res.json({ data: visits });
  } catch (e) {
    next(e);
  }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const q = alertQuerySchema.parse(req.query);

    const branches = await prisma.branch.findMany({
      where: { organisation: { slug: { not: platformOrgSlug } } },
      select: {
        id: true,
        name: true,
        organisationId: true,
        organisation: {
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
        },
      },
    });
    const branchIds = branches.map(branch => branch.id);
    const branchMap = new Map(branches.map(branch => [branch.id, branch]));

    const alerts = await prisma.alert.findMany({
      where: {
        branchId: { in: branchIds },
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: {
        actions: {
          orderBy: { timestamp: 'desc' },
          take: 10,
        },
      },
    });

    const patientIds = [...new Set(alerts.map(alert => alert.patientId))];
    const visitIds = [...new Set(alerts.map(alert => alert.visitId))];
    const actorIds = [
      ...new Set(
        alerts.flatMap(alert =>
          alert.actions.map(action => action.actorId).filter(Boolean),
        ),
      ),
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
            select: { id: true, displayName: true, email: true, role: true },
          })
        : Promise.resolve([]),
    ]);

    const patientById = new Map(patients.map(patient => [patient.id, patient]));
    const visitById = new Map(visits.map(visit => [visit.id, visit]));
    const actorById = new Map(actors.map(actor => [actor.id, actor]));

    res.json({
      data: alerts.map(alert => ({
        ...alert,
        branch: branchMap.get(alert.branchId) || null,
        patient: patientById.get(alert.patientId) || null,
        visit: visitById.get(alert.visitId) || null,
        actions: alert.actions.map(action => ({
          ...action,
          actor: action.actorId ? actorById.get(action.actorId) || null : null,
        })),
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/audit-logs', async (req, res, next) => {
  try {
    const q = auditQuerySchema.parse(req.query);
    const organisations = await listManagedOrganisations();
    const organisationIds = organisations.map(organisation => organisation.id);

    const logs = await prisma.auditLog.findMany({
      where: {
        orgId: { in: organisationIds },
        ...(q.action ? { action: q.action } : {}),
        ...(q.entity ? { entity: q.entity } : {}),
      },
      orderBy: { at: 'desc' },
      take: q.limit,
    });

    const actorIds = Array.from(
      new Set(logs.map(log => log.actorId).filter((value): value is string => Boolean(value))),
    );
    const actorMap = new Map(
      (
        actorIds.length
          ? await prisma.user.findMany({
              where: { id: { in: actorIds } },
              select: {
                id: true,
                displayName: true,
                email: true,
                role: true,
              },
            })
          : []
      ).map(actor => [actor.id, actor]),
    );
    const organisationMap = new Map(
      organisations.map(organisation => [organisation.id, organisation]),
    );

    res.json({
      data: logs.map(log => ({
        ...log,
        actor: log.actorId ? actorMap.get(log.actorId) || null : null,
        organisation: organisationMap.get(log.orgId) || null,
      })),
    });
  } catch (e) {
    next(e);
  }
});
