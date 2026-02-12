"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../../utils/prisma");
const auth_1 = require("../../utils/auth");
exports.router = (0, express_1.Router)();
const upsertSchema = zod_1.z.object({
    branchId: zod_1.z.string().optional(),
    type: zod_1.z.enum(['HEART_RATE', 'BP', 'TEMPERATURE']),
    low: zod_1.z.number().nullable().optional(),
    high: zod_1.z.number().nullable().optional(),
});
exports.router.post('/', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('ORG_ADMIN', 'BRANCH_MANAGER'), async (req, res, next) => {
    try {
        const data = upsertSchema.parse(req.body);
        const ctx = req.ctx;
        // Branch managers are locked to their branch
        let branchId = ctx.branchId || undefined;
        if (!branchId) {
            if (!data.branchId)
                return res.status(400).json({ error: { message: 'branchId is required' } });
            const branch = await prisma_1.prisma.branch.findUnique({ where: { id: data.branchId } });
            if (!branch || branch.organisationId !== ctx.orgId)
                return res.status(403).json({ error: { message: 'Forbidden' } });
            branchId = data.branchId;
        }
        const record = await prisma_1.prisma.thresholdProfile.upsert({
            where: { branchId_type: { branchId, type: data.type } },
            update: { low: data.low ?? null, high: data.high ?? null },
            create: { branchId, type: data.type, low: data.low ?? null, high: data.high ?? null }
        });
        res.status(201).json({ data: record });
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/:branchId', auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const ctx = req.ctx;
        const branchId = req.params.branchId;
        if (ctx.branchId && branchId !== ctx.branchId)
            return res.status(403).json({ error: { message: 'Forbidden' } });
        if (!ctx.branchId) {
            const branch = await prisma_1.prisma.branch.findUnique({ where: { id: branchId } });
            if (!branch || branch.organisationId !== ctx.orgId)
                return res.status(403).json({ error: { message: 'Forbidden' } });
        }
        const list = await prisma_1.prisma.thresholdProfile.findMany({ where: { branchId } });
        res.json({ data: list });
    }
    catch (e) {
        next(e);
    }
});
