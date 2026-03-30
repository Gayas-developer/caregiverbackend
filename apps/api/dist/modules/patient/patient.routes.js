"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../../utils/prisma");
const auth_1 = require("../../utils/auth");
const hub_1 = require("../../realtime/hub");
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
        const user = req.user;
        const branchIdToLookup = ctx.role === 'ORG_ADMIN'
            ? data.branchId
            : ctx.branchId;
        if (ctx.role === 'ORG_ADMIN' && !data.branchId) {
            return res.status(400).json({ error: { message: 'Please select a branch for this patient.' } });
        }
        if (ctx.role !== 'ORG_ADMIN' && !ctx.branchId) {
            return res.status(403).json({ error: { message: 'Branch context missing. Please contact admin.' } });
        }
        // Use a transaction so branch validation and patient create are atomic (avoids FK race).
        const patient = await prisma_1.prisma.$transaction(async (tx) => {
            const branch = await tx.branch.findFirst({
                where: { id: branchIdToLookup, organisationId: ctx.orgId },
                select: { id: true },
            });
            if (!branch) {
                if (ctx.role === 'ORG_ADMIN') {
                    throw Object.assign(new Error('Branch not found or not in your organisation.'), { status: 403 });
                }
                throw Object.assign(new Error('Invalid branch assignment. Please contact admin.'), { status: 403 });
            }
            return tx.patient.create({
                data: {
                    firstName: data.firstName,
                    lastName: data.lastName,
                    dob: data.dob ? new Date(data.dob) : null,
                    branchId: branch.id,
                },
            });
        });
        (0, hub_1.publishOrgEvent)(ctx.orgId, 'PATIENT_CREATED', {
            patient: {
                id: patient.id,
                firstName: patient.firstName,
                lastName: patient.lastName,
                branchId: patient.branchId,
                createdAt: patient.createdAt,
            },
            actorId: user.sub,
        }, { branchId: patient.branchId });
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
        const roleCanViewOrgWide = ctx.role === 'ORG_ADMIN' || ctx.role === 'CLINICAL_REVIEWER';
        // Caregiver + branch roles: hard lock
        if (!roleCanViewOrgWide) {
            if (!ctx.branchId) {
                return res.status(403).json({ error: { message: 'Branch context missing. Please contact admin.' } });
            }
            const list = await prisma_1.prisma.patient.findMany({
                where: { branchId: ctx.branchId },
                take: 50,
                orderBy: { createdAt: 'desc' },
            });
            return res.json({ data: list });
        }
        // ORG_ADMIN / org-wide reviewer: optional branch filter, but validate org ownership
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
        if (ctx.role === 'CLINICAL_REVIEWER' && ctx.branchId) {
            const list = await prisma_1.prisma.patient.findMany({
                where: { branchId: ctx.branchId },
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
