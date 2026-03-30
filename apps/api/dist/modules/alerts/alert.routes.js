"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../../utils/prisma");
const auth_1 = require("../../utils/auth");
const hub_1 = require("../../realtime/hub");
exports.router = (0, express_1.Router)();
const listSchema = zod_1.z.object({
    status: zod_1.z.enum(['OPEN', 'CLOSED']).optional(),
    branchId: zod_1.z.string().optional(),
    limit: zod_1.z.coerce.number().min(1).max(100).optional(),
});
exports.router.get('/', auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const ctx = req.ctx;
        const q = listSchema.parse(req.query);
        let allowedBranchIds = [];
        const roleCanViewOrgWide = ctx.role === 'ORG_ADMIN' || ctx.role === 'CLINICAL_REVIEWER';
        if (q.branchId) {
            const branch = await prisma_1.prisma.branch.findUnique({ where: { id: q.branchId } });
            if (!branch || branch.organisationId !== ctx.orgId) {
                return res
                    .status(403)
                    .json({ error: { message: 'Branch is not in your organisation' } });
            }
            allowedBranchIds = [q.branchId];
        }
        else if (!roleCanViewOrgWide) {
            if (!ctx.branchId) {
                return res.status(403).json({
                    error: { message: 'Branch context missing. Please contact admin.' },
                });
            }
            allowedBranchIds = [ctx.branchId];
        }
        else if (ctx.role === 'CLINICAL_REVIEWER' && ctx.branchId) {
            allowedBranchIds = [ctx.branchId];
        }
        else {
            const branches = await prisma_1.prisma.branch.findMany({
                where: { organisationId: ctx.orgId },
                select: { id: true },
            });
            allowedBranchIds = branches.map(b => b.id);
        }
        if (!allowedBranchIds.length) {
            return res.json({ data: [] });
        }
        const alerts = await prisma_1.prisma.alert.findMany({
            where: {
                branchId: { in: allowedBranchIds },
                ...(q.status ? { status: q.status } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: q.limit || 50,
            include: {
                actions: {
                    orderBy: { timestamp: 'desc' },
                    take: 10,
                },
            },
        });
        const patientIds = [...new Set(alerts.map(a => a.patientId))];
        const visitIds = [...new Set(alerts.map(a => a.visitId))];
        const actorIds = [
            ...new Set(alerts.flatMap(a => a.actions.map(act => act.actorId).filter(Boolean))),
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
                    select: { id: true, displayName: true, email: true },
                })
                : Promise.resolve([]),
        ]);
        const patientById = new Map(patients.map(p => [p.id, p]));
        const visitById = new Map(visits.map(v => [v.id, v]));
        const actorById = new Map(actors.map(a => [a.id, a]));
        const data = alerts.map(alert => ({
            ...alert,
            patient: patientById.get(alert.patientId) || null,
            visit: visitById.get(alert.visitId) || null,
            actions: alert.actions.map(action => ({
                ...action,
                actor: action.actorId ? actorById.get(action.actorId) || null : null,
            })),
        }));
        res.json({ data });
    }
    catch (e) {
        next(e);
    }
});
const addActionSchema = zod_1.z.object({
    action: zod_1.z.string().min(2).max(120),
    closeAlert: zod_1.z.boolean().optional(),
});
exports.router.post('/:id/actions', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('PLATFORM_ADMIN', 'ORG_ADMIN', 'BRANCH_MANAGER', 'CAREGIVER', 'CLINICAL_REVIEWER'), async (req, res, next) => {
    try {
        const id = zod_1.z.string().parse(req.params.id);
        const data = addActionSchema.parse(req.body);
        const user = req.user;
        const ctx = req.ctx;
        const alert = await prisma_1.prisma.alert.findUnique({ where: { id } });
        if (!alert)
            return res.status(404).json({ error: { message: 'Alert not found' } });
        const branch = await prisma_1.prisma.branch.findUnique({
            where: { id: alert.branchId },
            select: { id: true, organisationId: true },
        });
        if (ctx.role !== 'PLATFORM_ADMIN' && (!branch || branch.organisationId !== ctx.orgId)) {
            return res
                .status(403)
                .json({ error: { message: 'Alert is not in your organisation' } });
        }
        if (ctx.role !== 'PLATFORM_ADMIN' &&
            ctx.role !== 'ORG_ADMIN' &&
            ctx.branchId &&
            ctx.branchId !== alert.branchId) {
            return res
                .status(403)
                .json({ error: { message: 'You can only manage alerts in your branch' } });
        }
        if (ctx.role === 'CAREGIVER' && data.closeAlert) {
            return res
                .status(403)
                .json({ error: { message: 'Caregivers can escalate alerts but cannot resolve them' } });
        }
        const result = await prisma_1.prisma.$transaction(async (tx) => {
            const action = await tx.escalationAction.create({
                data: {
                    alertId: alert.id,
                    actorId: user.sub,
                    action: data.action,
                },
            });
            const updatedAlert = await tx.alert.update({
                where: { id: alert.id },
                data: data.closeAlert ? { status: 'CLOSED' } : {},
            });
            return { action, alert: updatedAlert };
        });
        (0, hub_1.publishOrgEvent)(ctx.orgId, 'ALERT_UPDATED', {
            alertId: result.alert.id,
            status: result.alert.status,
            action: {
                id: result.action.id,
                action: result.action.action,
                actorId: result.action.actorId,
                timestamp: result.action.timestamp,
            },
        }, { branchId: result.alert.branchId });
        res.status(201).json({ data: result });
    }
    catch (e) {
        next(e);
    }
});
