"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const bcrypt_1 = __importDefault(require("bcrypt"));
const crypto_1 = __importDefault(require("crypto"));
const auth_1 = require("../../utils/auth");
const prisma_1 = require("../../utils/prisma");
const platformAdmin_1 = require("../../utils/platformAdmin");
const mailer_1 = require("../../utils/mailer");
exports.router = (0, express_1.Router)();
exports.router.use(auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('PLATFORM_ADMIN'));
const platformOrgSlug = (0, platformAdmin_1.getPlatformAdminConfig)().organisationSlug;
const organisationCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    slug: zod_1.z.string().min(2),
    initialBranchName: zod_1.z.string().min(2).optional(),
});
const organisationUpdateSchema = zod_1.z
    .object({
    name: zod_1.z.string().min(2).optional(),
    slug: zod_1.z.string().min(2).optional(),
    isActive: zod_1.z.boolean().optional(),
})
    .refine(value => value.name !== undefined ||
    value.slug !== undefined ||
    value.isActive !== undefined, { message: 'At least one field must be updated' });
const orgAdminCreateSchema = zod_1.z.object({
    organisationId: zod_1.z.string().min(1),
    displayName: zod_1.z.string().min(2).max(80).optional(),
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    isActive: zod_1.z.boolean().optional().default(true),
});
const orgAdminUpdateSchema = zod_1.z
    .object({
    organisationId: zod_1.z.string().min(1).optional(),
    displayName: zod_1.z.string().min(2).max(80).optional(),
    isActive: zod_1.z.boolean().optional(),
})
    .refine(value => value.organisationId !== undefined ||
    value.displayName !== undefined ||
    value.isActive !== undefined, { message: 'At least one field must be updated' });
const setPasswordSchema = zod_1.z.object({
    newPassword: zod_1.z.string().min(6).optional(),
    sendEmail: zod_1.z.boolean().optional().default(false),
});
const visitListSchema = zod_1.z.object({
    status: zod_1.z.enum(['OPEN', 'CLOSED']).optional(),
    organisationId: zod_1.z.string().optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(200).optional().default(100),
});
const alertQuerySchema = zod_1.z.object({
    status: zod_1.z.enum(['OPEN', 'CLOSED']).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(200).optional().default(100),
});
const auditQuerySchema = zod_1.z.object({
    action: zod_1.z.string().min(1).optional(),
    entity: zod_1.z.string().min(1).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(200).optional().default(100),
});
async function listManagedOrganisations() {
    return prisma_1.prisma.organisation.findMany({
        where: {
            slug: { not: platformOrgSlug },
        },
        orderBy: { createdAt: 'desc' },
    });
}
async function assertManagedOrganisation(organisationId) {
    const organisation = await prisma_1.prisma.organisation.findFirst({
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
exports.router.get('/overview', async (_req, res, next) => {
    try {
        const organisations = await listManagedOrganisations();
        const organisationIds = organisations.map(organisation => organisation.id);
        const branches = await prisma_1.prisma.branch.findMany({
            where: { organisationId: { in: organisationIds } },
            select: { id: true },
        });
        const branchIds = branches.map(branch => branch.id);
        const [orgAdmins, patients, visits, openVisits, alerts, openAlerts,] = await Promise.all([
            prisma_1.prisma.user.count({
                where: {
                    role: 'ORG_ADMIN',
                    organisationId: { in: organisationIds },
                },
            }),
            prisma_1.prisma.patient.count({
                where: { branchId: { in: branchIds } },
            }),
            prisma_1.prisma.visit.count({
                where: { branchId: { in: branchIds } },
            }),
            prisma_1.prisma.visit.count({
                where: {
                    branchId: { in: branchIds },
                    status: 'OPEN',
                },
            }),
            prisma_1.prisma.alert.count({
                where: { branchId: { in: branchIds } },
            }),
            prisma_1.prisma.alert.count({
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/organisations', async (_req, res, next) => {
    try {
        const [organisations, adminCounts] = await Promise.all([
            prisma_1.prisma.organisation.findMany({
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
            prisma_1.prisma.user.groupBy({
                by: ['organisationId'],
                where: {
                    role: 'ORG_ADMIN',
                    organisation: { slug: { not: platformOrgSlug } },
                },
                _count: { _all: true },
            }),
        ]);
        const adminCountMap = new Map(adminCounts.map(item => [item.organisationId, item._count._all]));
        res.json({
            data: organisations.map(organisation => ({
                ...organisation,
                orgAdminCount: adminCountMap.get(organisation.id) || 0,
            })),
        });
    }
    catch (e) {
        next(e);
    }
});
exports.router.post('/organisations', async (req, res, next) => {
    try {
        const data = organisationCreateSchema.parse(req.body);
        const slugExists = await prisma_1.prisma.organisation.findUnique({
            where: { slug: data.slug },
            select: { id: true },
        });
        if (slugExists) {
            return res
                .status(409)
                .json({ error: { message: 'Organisation slug already exists' } });
        }
        const organisation = await prisma_1.prisma.$transaction(async (tx) => {
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.patch('/organisations/:id', async (req, res, next) => {
    try {
        const id = zod_1.z.string().parse(req.params.id);
        const data = organisationUpdateSchema.parse(req.body);
        await assertManagedOrganisation(id);
        if (data.slug) {
            const slugExists = await prisma_1.prisma.organisation.findFirst({
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
        const organisation = await prisma_1.prisma.organisation.update({
            where: { id },
            data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.slug !== undefined ? { slug: data.slug } : {}),
                ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            },
        });
        res.json({ data: organisation });
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/org-admins', async (_req, res, next) => {
    try {
        const users = await prisma_1.prisma.user.findMany({
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.post('/org-admins', async (req, res, next) => {
    try {
        const data = orgAdminCreateSchema.parse(req.body);
        await assertManagedOrganisation(data.organisationId);
        const normalizedEmail = data.email.trim().toLowerCase();
        const exists = await prisma_1.prisma.user.findUnique({
            where: { email: normalizedEmail },
            select: { id: true },
        });
        if (exists) {
            return res.status(409).json({ error: { message: 'Email already exists' } });
        }
        const passwordHash = await bcrypt_1.default.hash(data.password, 10);
        const user = await prisma_1.prisma.user.create({
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.patch('/org-admins/:id', async (req, res, next) => {
    try {
        const id = zod_1.z.string().parse(req.params.id);
        const data = orgAdminUpdateSchema.parse(req.body);
        const target = await prisma_1.prisma.user.findUnique({
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
        const user = await prisma_1.prisma.user.update({
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.post('/org-admins/:id/set-password', async (req, res, next) => {
    try {
        const id = zod_1.z.string().parse(req.params.id);
        const data = setPasswordSchema.parse(req.body);
        const target = await prisma_1.prisma.user.findUnique({
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
        const temporaryPassword = data.newPassword ||
            crypto_1.default
                .randomBytes(9)
                .toString('base64url')
                .replace(/[^A-Za-z0-9]/g, '')
                .slice(0, 12);
        const passwordHash = await bcrypt_1.default.hash(temporaryPassword, 10);
        await prisma_1.prisma.user.update({
            where: { id },
            data: { passwordHash },
        });
        if (data.sendEmail) {
            await (0, mailer_1.sendStaffTemporaryPasswordEmail)({
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/patients', async (_req, res, next) => {
    try {
        const patients = await prisma_1.prisma.patient.findMany({
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/visits', async (req, res, next) => {
    try {
        const q = visitListSchema.parse(req.query);
        const visits = await prisma_1.prisma.visit.findMany({
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/alerts', async (req, res, next) => {
    try {
        const q = alertQuerySchema.parse(req.query);
        const branches = await prisma_1.prisma.branch.findMany({
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
        const alerts = await prisma_1.prisma.alert.findMany({
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
            ...new Set(alerts.flatMap(alert => alert.actions.map(action => action.actorId).filter(Boolean))),
        ];
        const [patients, visits, actors] = await Promise.all([
            patientIds.length
                ? prisma_1.prisma.patient.findMany({
                    where: { id: { in: patientIds } },
                    select: { id: true, firstName: true, lastName: true, dob: true },
                })
                : Promise.resolve([]),
            visitIds.length
                ? prisma_1.prisma.visit.findMany({
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
                ? prisma_1.prisma.user.findMany({
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
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/audit-logs', async (req, res, next) => {
    try {
        const q = auditQuerySchema.parse(req.query);
        const organisations = await listManagedOrganisations();
        const organisationIds = organisations.map(organisation => organisation.id);
        const logs = await prisma_1.prisma.auditLog.findMany({
            where: {
                orgId: { in: organisationIds },
                ...(q.action ? { action: q.action } : {}),
                ...(q.entity ? { entity: q.entity } : {}),
            },
            orderBy: { at: 'desc' },
            take: q.limit,
        });
        const actorIds = Array.from(new Set(logs.map(log => log.actorId).filter((value) => Boolean(value))));
        const actorMap = new Map((actorIds.length
            ? await prisma_1.prisma.user.findMany({
                where: { id: { in: actorIds } },
                select: {
                    id: true,
                    displayName: true,
                    email: true,
                    role: true,
                },
            })
            : []).map(actor => [actor.id, actor]));
        const organisationMap = new Map(organisations.map(organisation => [organisation.id, organisation]));
        res.json({
            data: logs.map(log => ({
                ...log,
                actor: log.actorId ? actorMap.get(log.actorId) || null : null,
                organisation: organisationMap.get(log.orgId) || null,
            })),
        });
    }
    catch (e) {
        next(e);
    }
});
