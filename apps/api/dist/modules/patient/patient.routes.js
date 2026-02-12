"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../../utils/prisma");
const auth_1 = require("../../utils/auth");
exports.router = (0, express_1.Router)();
const createPatientSchema = zod_1.z.object({
    branchId: zod_1.z.string().optional(),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    dob: zod_1.z.string().optional(),
});
exports.router.post('/', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('ORG_ADMIN', 'BRANCH_MANAGER', 'CAREGIVER'), async (req, res, next) => {
    try {
        const data = createPatientSchema.parse(req.body);
        const ctx = req.ctx;
        let branchIdToUse;
        if (ctx.role === 'ORG_ADMIN') {
            if (!data.branchId) {
                return res.status(400).json({ error: { message: 'branchId is required for ORG_ADMIN' } });
            }
            const branch = await prisma_1.prisma.branch.findFirst({
                where: { id: data.branchId, organisationId: ctx.orgId },
                select: { id: true },
            });
            if (!branch) {
                return res.status(403).json({ error: { message: 'Branch not in your organisation' } });
            }
            branchIdToUse = branch.id;
        }
        else {
            if (!ctx.branchId) {
                return res.status(403).json({ error: { message: 'Branch context missing' } });
            }
            branchIdToUse = ctx.branchId;
        }
        const patient = await prisma_1.prisma.patient.create({
            data: {
                firstName: data.firstName,
                lastName: data.lastName,
                dob: data.dob ? new Date(data.dob) : null,
                branchId: branchIdToUse,
            },
        });
        res.status(201).json({ data: patient });
    }
    catch (e) {
        next(e);
    }
});
// router.get('/', authenticate, tenantScope, async (req, res, next) => {
//   try {
//     const ctx = (req as any).ctx as { orgId: string; branchId: string | null };
//     const list = await prisma.patient.findMany({
//       where: ctx.branchId
//         ? { branchId: ctx.branchId }
//         : { branch: { organisationId: ctx.orgId } },
//       take: 50,
//       orderBy: { createdAt: 'desc' }
//     });
//     res.json({ data: list });
//   } catch (e) { next(e); }
// });
exports.router.get('/', auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const ctx = req.ctx;
        const branchIdParam = req.query.branchId;
        // Caregiver + branch roles: hard lock
        if (ctx.role !== 'ORG_ADMIN') {
            const list = await prisma_1.prisma.patient.findMany({
                where: { branchId: ctx.branchId },
                take: 50,
                orderBy: { createdAt: 'desc' },
            });
            return res.json({ data: list });
        }
        // ORG_ADMIN: optional branch filter, but validate org ownership
        if (branchIdParam) {
            const branch = await prisma_1.prisma.branch.findFirst({
                where: { id: branchIdParam, organisationId: ctx.orgId },
                select: { id: true },
            });
            if (!branch)
                return res.status(403).json({ error: { message: 'Branch not in your organisation' } });
            const list = await prisma_1.prisma.patient.findMany({
                where: { branchId: branch.id },
                take: 50,
                orderBy: { createdAt: 'desc' },
            });
            return res.json({ data: list });
        }
        // ORG_ADMIN default: org-wide
        const list = await prisma_1.prisma.patient.findMany({
            where: { branch: { organisationId: ctx.orgId } },
            take: 50,
            orderBy: { createdAt: 'desc' },
        });
        res.json({ data: list });
    }
    catch (e) {
        next(e);
    }
});
