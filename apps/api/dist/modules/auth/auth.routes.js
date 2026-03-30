"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const express_1 = require("express");
const prisma_1 = require("../../utils/prisma");
const zod_1 = require("zod");
const bcrypt_1 = __importDefault(require("bcrypt"));
const crypto_1 = __importDefault(require("crypto"));
const auth_1 = require("../../utils/auth");
const mailer_1 = require("../../utils/mailer");
const platformAdmin_1 = require("../../utils/platformAdmin");
exports.router = (0, express_1.Router)();
const OTP_EXPIRES_MINUTES = 10;
const RESET_TOKEN_EXPIRES_MINUTES = 15;
const registerSchema = zod_1.z.object({
    displayName: zod_1.z.string().min(2),
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    organisation: zod_1.z.object({ name: zod_1.z.string().min(2), slug: zod_1.z.string().min(2) }),
    branch: zod_1.z.object({ name: zod_1.z.string().min(2) }).optional(),
});
exports.router.post("/register", async (req, res, next) => {
    try {
        const data = registerSchema.parse(req.body);
        const exists = await prisma_1.prisma.user.findUnique({
            where: { email: data.email },
        });
        if (exists)
            return res
                .status(409)
                .json({ error: { message: "Email already exists" } });
        const slugExists = await prisma_1.prisma.organisation.findUnique({
            where: { slug: data.organisation.slug },
        });
        if (slugExists)
            return res
                .status(409)
                .json({ error: { message: "Organisation slug already exists" } });
        const hash = await bcrypt_1.default.hash(data.password, 10);
        const org = await prisma_1.prisma.organisation.create({
            data: { name: data.organisation.name, slug: data.organisation.slug },
        });
        const branch = await prisma_1.prisma.branch.create({
            data: { name: data.branch?.name || "Main", organisationId: org.id },
        });
        const user = await prisma_1.prisma.user.create({
            data: {
                displayName: data.displayName,
                email: data.email,
                passwordHash: hash,
                isActive: true,
                role: "ORG_ADMIN",
                organisationId: org.id,
                branchId: null,
            },
        });
        const access = (0, auth_1.signAccessToken)({
            sub: user.id,
            orgId: org.id,
            branchId: null,
            role: user.role,
        });
        const refresh = (0, auth_1.signRefreshToken)({
            sub: user.id,
            orgId: org.id,
            branchId: null,
            role: user.role,
        });
        res
            .status(201)
            .json({
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    organisationId: org.id,
                    branchId: null,
                    defaultBranchId: branch.id,
                },
                tokens: { access, refresh },
            },
        });
    }
    catch (e) {
        next(e);
    }
});
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
});
exports.router.post("/login", async (req, res, next) => {
    try {
        const { email, password } = loginSchema.parse(req.body);
        const normalizedEmail = email.trim().toLowerCase();
        if ((0, platformAdmin_1.isPlatformAdminEmail)(normalizedEmail)) {
            const config = (0, platformAdmin_1.getPlatformAdminConfig)();
            if (password !== config.password) {
                return res
                    .status(401)
                    .json({ error: { message: "Invalid credentials" } });
            }
            const { organisation, user } = await (0, platformAdmin_1.ensurePlatformAdminAccount)();
            const access = (0, auth_1.signAccessToken)({
                sub: user.id,
                orgId: organisation.id,
                branchId: null,
                role: user.role,
            });
            const refresh = (0, auth_1.signRefreshToken)({
                sub: user.id,
                orgId: organisation.id,
                branchId: null,
                role: user.role,
            });
            return res.json({
                data: {
                    user: { id: user.id, email: user.email, role: user.role },
                    tokens: { access, refresh },
                },
            });
        }
        const user = await prisma_1.prisma.user.findUnique({
            where: { email: normalizedEmail },
            include: {
                organisation: {
                    select: { isActive: true },
                },
            },
        });
        if (!user)
            return res
                .status(401)
                .json({ error: { message: "Invalid credentials" } });
        if (!user.isActive)
            return res
                .status(403)
                .json({
                error: { message: "Account is inactive. Contact your administrator." },
            });
        if (!user.organisation?.isActive)
            return res
                .status(403)
                .json({
                error: {
                    message: "Organisation access is inactive. Contact My Homecare support.",
                },
            });
        if ((user.role === "CAREGIVER" || user.role === "BRANCH_MANAGER") &&
            !user.branchId) {
            return res
                .status(403)
                .json({ error: { message: "User is not assigned to a branch" } });
        }
        const ok = await bcrypt_1.default.compare(password, user.passwordHash);
        if (!ok)
            return res
                .status(401)
                .json({ error: { message: "Invalid credentials" } });
        const access = (0, auth_1.signAccessToken)({
            sub: user.id,
            orgId: user.organisationId,
            branchId: user.branchId || null,
            role: user.role,
        });
        const refresh = (0, auth_1.signRefreshToken)({
            sub: user.id,
            orgId: user.organisationId,
            branchId: user.branchId || null,
            role: user.role,
        });
        res.json({
            data: {
                user: { id: user.id, email: user.email, role: user.role },
                tokens: { access, refresh },
            },
        });
    }
    catch (e) {
        next(e);
    }
});
const forgotPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
});
exports.router.post("/forgot-password", async (req, res, next) => {
    try {
        const { email } = forgotPasswordSchema.parse(req.body);
        const user = await prisma_1.prisma.user.findUnique({ where: { email } });
        // Always return a generic success message to avoid account enumeration.
        if (!user) {
            return res.json({
                data: { message: "If an account exists, an OTP has been sent." },
            });
        }
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const otpHash = await bcrypt_1.default.hash(otp, 10);
        const otpExpiresAt = new Date(Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000);
        await prisma_1.prisma.passwordReset.upsert({
            where: { userId: user.id },
            create: {
                userId: user.id,
                otpHash,
                otpExpiresAt,
            },
            update: {
                otpHash,
                otpExpiresAt,
                attempts: 0,
                verifiedAt: null,
                resetTokenHash: null,
                resetTokenExpiresAt: null,
                consumedAt: null,
            },
        });
        await (0, mailer_1.sendPasswordResetOtpEmail)({ to: email, otp });
        res.json({
            data: { message: "If an account exists, an OTP has been sent." },
        });
    }
    catch (e) {
        next(e);
    }
});
const verifyResetOtpSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    otp: zod_1.z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});
exports.router.post("/verify-reset-otp", async (req, res, next) => {
    try {
        const { email, otp } = verifyResetOtpSchema.parse(req.body);
        const user = await prisma_1.prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(400).json({ error: { message: "Invalid OTP" } });
        }
        const reset = await prisma_1.prisma.passwordReset.findUnique({
            where: { userId: user.id },
        });
        if (!reset || reset.consumedAt) {
            return res.status(400).json({ error: { message: "Invalid OTP" } });
        }
        if (reset.otpExpiresAt.getTime() < Date.now()) {
            return res.status(400).json({ error: { message: "OTP expired" } });
        }
        if (reset.attempts >= 5) {
            return res.status(429).json({
                error: { message: "Too many failed attempts. Request a new OTP." },
            });
        }
        const ok = await bcrypt_1.default.compare(otp, reset.otpHash);
        if (!ok) {
            await prisma_1.prisma.passwordReset.update({
                where: { userId: user.id },
                data: { attempts: { increment: 1 } },
            });
            return res.status(400).json({ error: { message: "Invalid OTP" } });
        }
        const resetToken = crypto_1.default.randomBytes(32).toString("hex");
        const resetTokenHash = crypto_1.default
            .createHash("sha256")
            .update(resetToken)
            .digest("hex");
        await prisma_1.prisma.passwordReset.update({
            where: { userId: user.id },
            data: {
                verifiedAt: new Date(),
                attempts: 0,
                resetTokenHash,
                resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000),
            },
        });
        res.json({
            data: {
                resetToken,
                expiresInSeconds: RESET_TOKEN_EXPIRES_MINUTES * 60,
            },
        });
    }
    catch (e) {
        next(e);
    }
});
const resetPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    resetToken: zod_1.z.string().min(16),
    newPassword: zod_1.z.string().min(6),
});
exports.router.post("/reset-password", async (req, res, next) => {
    try {
        const { email, resetToken, newPassword } = resetPasswordSchema.parse(req.body);
        const user = await prisma_1.prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(400).json({ error: { message: "Invalid reset token" } });
        }
        const reset = await prisma_1.prisma.passwordReset.findUnique({
            where: { userId: user.id },
        });
        if (!reset ||
            reset.consumedAt ||
            !reset.resetTokenHash ||
            !reset.resetTokenExpiresAt) {
            return res.status(400).json({ error: { message: "Invalid reset token" } });
        }
        if (reset.resetTokenExpiresAt.getTime() < Date.now()) {
            return res
                .status(400)
                .json({ error: { message: "Reset token expired" } });
        }
        const providedHash = crypto_1.default
            .createHash("sha256")
            .update(resetToken)
            .digest("hex");
        if (providedHash !== reset.resetTokenHash) {
            return res.status(400).json({ error: { message: "Invalid reset token" } });
        }
        const passwordHash = await bcrypt_1.default.hash(newPassword, 10);
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.user.update({
                where: { id: user.id },
                data: { passwordHash },
            }),
            prisma_1.prisma.passwordReset.update({
                where: { userId: user.id },
                data: {
                    consumedAt: new Date(),
                    resetTokenHash: null,
                    resetTokenExpiresAt: null,
                },
            }),
        ]);
        res.json({ data: { message: "Password reset successful" } });
    }
    catch (e) {
        next(e);
    }
});
exports.router.post("/refresh", async (req, res, next) => {
    try {
        const { refresh } = zod_1.z
            .object({ refresh: zod_1.z.string().min(1) })
            .parse(req.body);
        const payload = (0, auth_1.verifyRefreshToken)(refresh);
        const revoked = await prisma_1.prisma.revokedToken.findUnique({
            where: { jti: payload.jti },
        });
        if (revoked)
            return res
                .status(401)
                .json({ error: { message: "Refresh token revoked" } });
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: payload.sub },
            include: {
                organisation: {
                    select: { isActive: true },
                },
            },
        });
        if (!user)
            return res.status(401).json({ error: { message: "User not found" } });
        if (!user.isActive)
            return res
                .status(403)
                .json({
                error: { message: "Account is inactive. Contact your administrator." },
            });
        if (user.role !== "PLATFORM_ADMIN" && !user.organisation?.isActive)
            return res
                .status(403)
                .json({
                error: {
                    message: "Organisation access is inactive. Contact My Homecare support.",
                },
            });
        const access = (0, auth_1.signAccessToken)({
            sub: user.id,
            orgId: user.organisationId,
            branchId: user.branchId || null,
            role: user.role,
        });
        const newRefresh = (0, auth_1.signRefreshToken)({
            sub: user.id,
            orgId: user.organisationId,
            branchId: user.branchId || null,
            role: user.role,
        });
        await prisma_1.prisma.revokedToken.create({
            data: {
                jti: payload.jti,
                type: "refresh",
                expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
            },
        });
        res.json({ data: { tokens: { access, refresh: newRefresh } } });
    }
    catch (e) {
        next(e);
    }
});
exports.router.post("/logout", async (req, res, next) => {
    try {
        const { token, type } = zod_1.z
            .object({ token: zod_1.z.string().min(1), type: zod_1.z.enum(["access", "refresh"]) })
            .parse(req.body);
        const secret = type === "refresh"
            ? process.env.JWT_REFRESH_SECRET
            : process.env.JWT_ACCESS_SECRET;
        const payload = jsonwebtoken_1.default.verify(token, secret);
        const expSec = Math.max(0, (payload.exp ?? 0) - Math.floor(Date.now() / 1000));
        await prisma_1.prisma.revokedToken.create({
            data: {
                jti: payload.jti,
                type,
                expiresAt: new Date(Date.now() + expSec * 1000),
            },
        });
        res.json({ data: { ok: true } });
    }
    catch (e) {
        next(e);
    }
});
