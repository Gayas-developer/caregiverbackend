"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const bcrypt_1 = __importDefault(require("bcrypt"));
const prisma_1 = require("../../utils/prisma");
const auth_1 = require("../../utils/auth");
exports.router = (0, express_1.Router)();
exports.router.get("/me", auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const user = req.user;
        const ctx = req.ctx;
        const me = await prisma_1.prisma.user.findFirst({
            where: { id: user.sub, organisationId: ctx.orgId },
            select: {
                id: true,
                email: true,
                role: true,
                organisationId: true,
                branchId: true,
                displayName: true, // ✅ you added this
                createdAt: true,
                organisation: { select: { id: true, name: true, slug: true } },
                branch: { select: { id: true, name: true } },
            },
        });
        if (!me)
            return res.status(404).json({ error: { message: "User not found" } });
        res.json({ data: me });
    }
    catch (e) {
        next(e);
    }
});
const updateProfileSchema = zod_1.z.object({
    displayName: zod_1.z.string().min(2).max(80).optional(),
    // later you can add phone/avatarUrl etc
});
exports.router.patch("/me", auth_1.authenticate, auth_1.tenantScope, async (req, res, next) => {
    try {
        const user = req.user;
        const ctx = req.ctx;
        const data = updateProfileSchema.parse(req.body);
        // ensure user belongs to org (defensive)
        const exists = await prisma_1.prisma.user.findFirst({
            where: { id: user.sub, organisationId: ctx.orgId },
            select: { id: true },
        });
        if (!exists)
            return res.status(404).json({ error: { message: "User not found" } });
        const updated = await prisma_1.prisma.user.update({
            where: { id: user.sub },
            data: {
                ...(data.displayName !== undefined
                    ? { displayName: data.displayName }
                    : {}),
            },
            select: {
                id: true,
                email: true,
                role: true,
                organisationId: true,
                branchId: true,
                displayName: true,
                createdAt: true,
                organisation: { select: { id: true, name: true, slug: true } },
                branch: { select: { id: true, name: true } },
            },
        });
        res.json({ data: updated });
    }
    catch (e) {
        next(e);
    }
});
const changePasswordSchema = zod_1.z.object({
    oldPassword: zod_1.z.string().min(6),
    newPassword: zod_1.z.string().min(6),
});
exports.router.post("/change-password", auth_1.authenticate, async (req, res, next) => {
    try {
        const user = req.user;
        const { oldPassword, newPassword } = changePasswordSchema.parse(req.body);
        const dbUser = await prisma_1.prisma.user.findUnique({
            where: { id: user.sub },
        });
        if (!dbUser) {
            return res.status(404).json({ error: { message: "User not found" } });
        }
        const ok = await bcrypt_1.default.compare(oldPassword, dbUser.passwordHash);
        if (!ok) {
            return res
                .status(400)
                .json({ error: { message: "Incorrect old password" } });
        }
        const hash = await bcrypt_1.default.hash(newPassword, 10);
        await prisma_1.prisma.user.update({
            where: { id: user.sub },
            data: { passwordHash: hash },
        });
        res.json({ data: { message: "Password updated successfully" } });
    }
    catch (e) {
        next(e);
    }
});
