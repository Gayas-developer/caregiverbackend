"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../../utils/prisma");
const auth_1 = require("../../utils/auth");
const hub_1 = require("../../realtime/hub");
exports.router = (0, express_1.Router)();
const startVisitSchema = zod_1.z.object({
    patientId: zod_1.z.string(),
    startedAt: zod_1.z.string().datetime().optional(),
    notes: zod_1.z.string().optional(),
});
const updateVisitSchema = zod_1.z.object({
    notes: zod_1.z.string().optional(),
    symptoms: zod_1.z.any().optional(), // stored as JSON
});
exports.router.post('/', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('ORG_ADMIN', 'BRANCH_MANAGER', 'CAREGIVER'), async (req, res, next) => {
    try {
        const data = startVisitSchema.parse(req.body);
        const ctx = req.ctx;
        const user = req.user;
        const patient = await prisma_1.prisma.patient.findUnique({
            where: { id: data.patientId },
            include: { branch: true }
        });
        if (!patient)
            return res.status(404).json({ error: { message: 'Patient not found' } });
        if (patient.archivedAt) {
            return res.status(409).json({
                error: { message: 'This patient has been archived and cannot start a new visit.' },
            });
        }
        if (patient.branch.organisationId !== ctx.orgId)
            return res.status(403).json({ error: { message: 'Patient is not in your organisation' } });
        if (ctx.role === 'CAREGIVER' || ctx.role === 'BRANCH_MANAGER') {
            if (!ctx.branchId) {
                return res.status(403).json({ error: { message: 'Branch context missing. Please contact admin.' } });
            }
            if (patient.branchId !== ctx.branchId) {
                return res.status(403).json({ error: { message: 'You can only start visits for patients in your branch' } });
            }
        }
        const visit = await prisma_1.prisma.visit.create({
            data: {
                patientId: patient.id,
                branchId: patient.branchId,
                caregiverId: user.sub,
                startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
                notes: data.notes
            }
        });
        (0, hub_1.publishOrgEvent)(ctx.orgId, 'VISIT_STARTED', {
            visit: {
                id: visit.id,
                patientId: visit.patientId,
                branchId: visit.branchId,
                caregiverId: visit.caregiverId,
                status: visit.status,
                startedAt: visit.startedAt,
            },
            actorId: user.sub,
        }, { branchId: visit.branchId });
        res.status(201).json({ data: visit });
    }
    catch (e) {
        next(e);
    }
});
exports.router.patch('/:id/close', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('ORG_ADMIN', 'BRANCH_MANAGER', 'CAREGIVER'), async (req, res, next) => {
    try {
        const id = zod_1.z.string().parse(req.params.id);
        const ctx = req.ctx;
        const user = req.user;
        const visit = await prisma_1.prisma.visit.findUnique({
            where: { id },
            include: { patient: { include: { branch: true } } }
        });
        if (!visit)
            return res.status(404).json({ error: { message: 'Visit not found' } });
        if (visit.patient.branch.organisationId !== ctx.orgId)
            return res.status(403).json({ error: { message: 'Visit is not in your organisation' } });
        if (ctx.role !== 'ORG_ADMIN' && ctx.branchId && visit.branchId !== ctx.branchId)
            return res.status(403).json({ error: { message: 'You can only access visits in your branch' } });
        if (ctx.role === 'CAREGIVER' && visit.caregiverId !== user.sub) {
            return res.status(403).json({ error: { message: 'You can only close your own visits' } });
        }
        if (visit.status !== 'OPEN') {
            return res.status(409).json({ error: { message: 'Visit already closed' } });
        }
        const updated = await prisma_1.prisma.visit.update({
            where: { id },
            data: { status: 'CLOSED', endedAt: new Date() }
        });
        (0, hub_1.publishOrgEvent)(ctx.orgId, 'VISIT_CLOSED', {
            visit: {
                id: updated.id,
                patientId: updated.patientId,
                branchId: updated.branchId,
                caregiverId: updated.caregiverId,
                status: updated.status,
                endedAt: updated.endedAt,
            },
            actorId: user.sub,
        }, { branchId: updated.branchId });
        res.json({ data: updated });
    }
    catch (e) {
        next(e);
    }
});
const listSchema = zod_1.z.object({
    patientId: zod_1.z.string().optional(),
    branchId: zod_1.z.string().optional(),
    status: zod_1.z.enum(['OPEN', 'CLOSED']).optional()
});
exports.router.get('/', auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const ctx = req.ctx;
        const q = listSchema.parse(req.query);
        let branchId;
        const roleCanViewOrgWide = ctx.role === 'ORG_ADMIN' || ctx.role === 'CLINICAL_REVIEWER';
        if (q.branchId) {
            branchId = q.branchId;
        }
        else if (!roleCanViewOrgWide) {
            if (!ctx.branchId) {
                return res.status(403).json({ error: { message: 'Branch context missing. Please contact admin.' } });
            }
            branchId = ctx.branchId;
        }
        else if (ctx.role === 'CLINICAL_REVIEWER' && ctx.branchId) {
            branchId = ctx.branchId;
        }
        if (branchId && roleCanViewOrgWide) {
            const branch = await prisma_1.prisma.branch.findUnique({ where: { id: branchId } });
            if (!branch || branch.organisationId !== ctx.orgId)
                return res.status(403).json({ error: { message: 'Branch is not in your organisation' } });
        }
        const visits = await prisma_1.prisma.visit.findMany({
            where: {
                branch: { organisationId: ctx.orgId },
                ...(branchId ? { branchId } : {}),
                ...(q.patientId ? { patientId: q.patientId } : {}),
                ...(q.status ? { status: q.status } : {}),
            },
            orderBy: { startedAt: 'desc' },
            take: 50,
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
            },
        });
        res.json({ data: visits });
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/:id', auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const id = zod_1.z.string().parse(req.params.id);
        const ctx = req.ctx;
        const visit = await prisma_1.prisma.visit.findUnique({
            where: { id },
            include: {
                patient: true,
                vitals: { orderBy: { recordedAt: 'asc' } }
            }
        });
        if (!visit)
            return res.status(404).json({ error: { message: 'Visit not found' } });
        const branch = await prisma_1.prisma.branch.findUnique({ where: { id: visit.branchId } });
        if (!branch || branch.organisationId !== ctx.orgId)
            return res.status(403).json({ error: { message: 'Visit is not in your organisation' } });
        if (ctx.role !== 'ORG_ADMIN' && ctx.branchId && visit.branchId !== ctx.branchId)
            return res.status(403).json({ error: { message: 'You can only access visits in your branch' } });
        res.json({ data: visit });
    }
    catch (e) {
        next(e);
    }
});
exports.router.patch('/:id', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('ORG_ADMIN', 'BRANCH_MANAGER', 'CAREGIVER'), async (req, res, next) => {
    try {
        const id = zod_1.z.string().parse(req.params.id);
        const data = updateVisitSchema.parse(req.body);
        const ctx = req.ctx;
        const user = req.user;
        const visit = await prisma_1.prisma.visit.findUnique({
            where: { id },
            include: {
                vitals: { orderBy: { recordedAt: 'desc' } },
                patient: { select: { id: true, firstName: true, lastName: true, dob: true, branchId: true, branch: true } },
                caregiver: { select: { id: true, displayName: true, email: true } },
            },
            // include: { patient: { include: { branch: true } } },
        });
        if (!visit)
            return res.status(404).json({ error: { message: 'Visit not found' } });
        if (visit.patient.branch.organisationId !== ctx.orgId)
            return res.status(403).json({ error: { message: 'Visit is not in your organisation' } });
        if (ctx.role !== 'ORG_ADMIN' && ctx.branchId && visit.branchId !== ctx.branchId)
            return res.status(403).json({ error: { message: 'You can only access visits in your branch' } });
        if (ctx.role === 'CAREGIVER' && visit.caregiverId !== user.sub) {
            return res.status(403).json({ error: { message: 'You can only edit your own visits' } });
        }
        // Optional: only allow editing while OPEN
        if (visit.status !== 'OPEN') {
            return res.status(409).json({ error: { message: 'Visit is closed' } });
        }
        const updated = await prisma_1.prisma.visit.update({
            where: { id },
            data: {
                ...(data.notes !== undefined ? { notes: data.notes } : {}),
                ...(data.symptoms !== undefined ? { symptoms: data.symptoms } : {}),
            },
        });
        res.json({ data: updated });
    }
    catch (e) {
        next(e);
    }
});
