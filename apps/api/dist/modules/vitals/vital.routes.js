"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../../utils/prisma");
const auth_1 = require("../../utils/auth");
const thresholds_1 = require("../../services/thresholds");
const producers_1 = require("../../jobs/producers");
exports.router = (0, express_1.Router)();
const vitalSchema = zod_1.z.object({
    visitId: zod_1.z.string(),
    type: zod_1.z.enum(['HEART_RATE', 'BP', 'TEMPERATURE']),
    valueNum: zod_1.z.number().optional(),
    systolic: zod_1.z.number().int().optional(),
    diastolic: zod_1.z.number().int().optional(),
    unit: zod_1.z.string().optional(),
    recordedAt: zod_1.z.string().datetime().optional()
});
exports.router.post('/', auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const data = vitalSchema.parse(req.body);
        const ctx = req.ctx;
        const user = req.user;
        const visit = await prisma_1.prisma.visit.findUnique({
            where: { id: data.visitId },
            include: { patient: { include: { branch: true } } }
        });
        if (!visit)
            return res.status(404).json({ error: { message: 'Visit not found' } });
        if (visit.patient.branch.organisationId !== ctx.orgId)
            return res.status(403).json({ error: { message: 'Forbidden' } });
        if (ctx.branchId && visit.branchId !== ctx.branchId)
            return res.status(403).json({ error: { message: 'Forbidden' } });
        if (visit.status !== 'OPEN')
            return res.status(409).json({ error: { message: 'Visit is closed' } });
        // For caregivers, enforce that they can only record vitals on visits they own
        if (ctx.role === 'CAREGIVER' && visit.caregiverId !== user.sub) {
            return res.status(403).json({ error: { message: 'Forbidden' } });
        }
        const vital = await prisma_1.prisma.vitalReading.create({
            data: {
                patientId: visit.patientId,
                visitId: data.visitId,
                type: data.type,
                valueNum: data.valueNum,
                systolic: data.systolic,
                diastolic: data.diastolic,
                unit: data.unit,
                recordedAt: data.recordedAt ? new Date(data.recordedAt) : undefined
            }
        });
        const alert = await (0, thresholds_1.evaluateThresholdsAndCreateAlertIfNeeded)(vital);
        if (alert)
            await (0, producers_1.enqueueAlertEmail)(alert);
        res.status(201).json({ data: { vital, alert } });
    }
    catch (e) {
        next(e);
    }
});
