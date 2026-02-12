"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../../utils/prisma");
const auth_1 = require("../../utils/auth");
const bcrypt_1 = __importDefault(require("bcrypt"));
exports.router = (0, express_1.Router)();
exports.router.get('/me', auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const user = req.user;
        const dbUser = await prisma_1.prisma.user.findUnique({
            where: { id: user.sub },
            select: { organisationId: true },
        });
        if (!dbUser)
            return res.status(401).json({ error: { message: 'Unauthorized' } });
        const org = await prisma_1.prisma.organisation.findUnique({
            where: { id: dbUser.organisationId },
            include: { branches: true }
        });
        res.json({ data: org });
    }
    catch (e) {
        next(e);
    }
});
const branchCreateSchema = zod_1.z.object({ name: zod_1.z.string().min(2) });
exports.router.post('/branches', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('ORG_ADMIN'), async (req, res, next) => {
    try {
        const data = branchCreateSchema.parse(req.body);
        const user = req.user;
        const dbUser = await prisma_1.prisma.user.findUnique({
            where: { id: user.sub },
            select: { organisationId: true },
        });
        if (!dbUser)
            return res.status(401).json({ error: { message: 'Unauthorized' } });
        const org = await prisma_1.prisma.organisation.findUnique({
            where: { id: dbUser.organisationId },
            select: { id: true },
        });
        if (!org) {
            return res
                .status(400)
                .json({ error: { message: 'Organisation not found for current user' } });
        }
        const branch = await prisma_1.prisma.branch.create({
            data: { name: data.name, organisationId: org.id },
        });
        res.status(201).json({ data: branch });
    }
    catch (e) {
        next(e);
    }
});
exports.router.get('/branches', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('ORG_ADMIN'), async (req, res, next) => {
    try {
        const user = req.user;
        const dbUser = await prisma_1.prisma.user.findUnique({
            where: { id: user.sub },
            select: { organisationId: true },
        });
        if (!dbUser)
            return res.status(401).json({ error: { message: 'Unauthorized' } });
        const branches = await prisma_1.prisma.branch.findMany({
            where: { organisationId: dbUser.organisationId },
        });
        res.json({ data: branches });
    }
    catch (e) {
        next(e);
    }
});
const createUserSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    role: zod_1.z.enum(['ORG_ADMIN', 'BRANCH_MANAGER', 'CLINICAL_REVIEWER', 'CAREGIVER']),
    branchId: zod_1.z.string().optional()
});
exports.router.post('/users', auth_1.authenticate, auth_1.tenantScope, (0, auth_1.requireRole)('ORG_ADMIN', 'BRANCH_MANAGER'), async (req, res, next) => {
    try {
        const data = createUserSchema.parse(req.body);
        const ctx = req.ctx;
        // Branch managers can only create caregivers in their branch
        let branchId = ctx.branchId || undefined;
        if (ctx.role === 'BRANCH_MANAGER') {
            if (data.role !== 'CAREGIVER')
                return res.status(403).json({ error: { message: 'Forbidden' } });
        }
        if (!branchId && data.branchId) {
            const branch = await prisma_1.prisma.branch.findUnique({ where: { id: data.branchId } });
            if (!branch || branch.organisationId !== ctx.orgId)
                return res.status(403).json({ error: { message: 'Forbidden' } });
            branchId = data.branchId;
        }
        const exists = await prisma_1.prisma.user.findUnique({ where: { email: data.email } });
        if (exists)
            return res.status(409).json({ error: { message: 'Email already exists' } });
        const hash = await bcrypt_1.default.hash(data.password, 10);
        const user = await prisma_1.prisma.user.create({
            data: {
                email: data.email,
                passwordHash: hash,
                role: data.role,
                organisationId: ctx.orgId,
                branchId
            },
            select: { id: true, email: true, role: true, organisationId: true, branchId: true, createdAt: true }
        });
        res.status(201).json({ data: user });
    }
    catch (e) {
        next(e);
    }
});
