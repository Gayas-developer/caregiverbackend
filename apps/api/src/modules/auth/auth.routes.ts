import jwt from "jsonwebtoken";
import { Router } from "express";
import { prisma } from "../../utils/prisma";
import { z } from "zod";
import bcrypt from "bcrypt";
import crypto from "crypto";
import {
  authenticate,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/auth";
import { sendPasswordResetOtpEmail } from "../../utils/mailer";

export const router = Router();

const OTP_EXPIRES_MINUTES = 10;
const RESET_TOKEN_EXPIRES_MINUTES = 15;

const registerSchema = z.object({
  displayName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  organisation: z.object({ name: z.string().min(2), slug: z.string().min(2) }),
  branch: z.object({ name: z.string().min(2) }).optional(),
});

router.post("/register", async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const exists = await prisma.user.findUnique({
      where: { email: data.email },
    });
    if (exists)
      return res
        .status(409)
        .json({ error: { message: "Email already exists" } });

    const slugExists = await prisma.organisation.findUnique({
      where: { slug: data.organisation.slug },
    });
    if (slugExists)
      return res
        .status(409)
        .json({ error: { message: "Organisation slug already exists" } });

    const hash = await bcrypt.hash(data.password, 10);

    const org = await prisma.organisation.create({
      data: { name: data.organisation.name, slug: data.organisation.slug },
    });
    const branch = await prisma.branch.create({
      data: { name: data.branch?.name || "Main", organisationId: org.id },
    });
    const user = await prisma.user.create({
      data: {
        displayName: data.displayName,
        email: data.email,
        passwordHash: hash,
        role: "CAREGIVER",
        organisationId: org.id,
        branchId: branch.id,
      },
    });

    const access = signAccessToken({
      sub: user.id,
      orgId: org.id,
      branchId: branch.id,
      role: user.role,
    });
    const refresh = signRefreshToken({
      sub: user.id,
      orgId: org.id,
      branchId: branch.id,
      role: user.role,
    });
    res
      .status(201)
      .json({
        data: {
          user: { id: user.id, email: user.email, role: user.role },
          tokens: { access, refresh },
        },
      });
  } catch (e) {
    next(e);
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user)
      return res
        .status(401)
        .json({ error: { message: "Invalid credentials" } });
    if (
      (user.role === "CAREGIVER" || user.role === "BRANCH_MANAGER") &&
      !user.branchId
    ) {
      return res
        .status(403)
        .json({ error: { message: "User is not assigned to a branch" } });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok)
      return res
        .status(401)
        .json({ error: { message: "Invalid credentials" } });

    const access = signAccessToken({
      sub: user.id,
      orgId: user.organisationId,
      branchId: user.branchId || null,
      role: user.role,
    });
    const refresh = signRefreshToken({
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
  } catch (e) {
    next(e);
  }
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });

    // Always return a generic success message to avoid account enumeration.
    if (!user) {
      return res.json({
        data: { message: "If an account exists, an OTP has been sent." },
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = await bcrypt.hash(otp, 10);
    const otpExpiresAt = new Date(
      Date.now() + OTP_EXPIRES_MINUTES * 60 * 1000,
    );

    await prisma.passwordReset.upsert({
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

    await sendPasswordResetOtpEmail({ to: email, otp });

    res.json({
      data: { message: "If an account exists, an OTP has been sent." },
    });
  } catch (e) {
    next(e);
  }
});

const verifyResetOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
});

router.post("/verify-reset-otp", async (req, res, next) => {
  try {
    const { email, otp } = verifyResetOtpSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: { message: "Invalid OTP" } });
    }

    const reset = await prisma.passwordReset.findUnique({
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

    const ok = await bcrypt.compare(otp, reset.otpHash);
    if (!ok) {
      await prisma.passwordReset.update({
        where: { userId: user.id },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json({ error: { message: "Invalid OTP" } });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    await prisma.passwordReset.update({
      where: { userId: user.id },
      data: {
        verifiedAt: new Date(),
        attempts: 0,
        resetTokenHash,
        resetTokenExpiresAt: new Date(
          Date.now() + RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000,
        ),
      },
    });

    res.json({
      data: {
        resetToken,
        expiresInSeconds: RESET_TOKEN_EXPIRES_MINUTES * 60,
      },
    });
  } catch (e) {
    next(e);
  }
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  resetToken: z.string().min(16),
  newPassword: z.string().min(6),
});

router.post("/reset-password", async (req, res, next) => {
  try {
    const { email, resetToken, newPassword } = resetPasswordSchema.parse(
      req.body,
    );
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: { message: "Invalid reset token" } });
    }

    const reset = await prisma.passwordReset.findUnique({
      where: { userId: user.id },
    });
    if (
      !reset ||
      reset.consumedAt ||
      !reset.resetTokenHash ||
      !reset.resetTokenExpiresAt
    ) {
      return res.status(400).json({ error: { message: "Invalid reset token" } });
    }
    if (reset.resetTokenExpiresAt.getTime() < Date.now()) {
      return res
        .status(400)
        .json({ error: { message: "Reset token expired" } });
    }

    const providedHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    if (providedHash !== reset.resetTokenHash) {
      return res.status(400).json({ error: { message: "Invalid reset token" } });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      prisma.passwordReset.update({
        where: { userId: user.id },
        data: {
          consumedAt: new Date(),
          resetTokenHash: null,
          resetTokenExpiresAt: null,
        },
      }),
    ]);

    res.json({ data: { message: "Password reset successful" } });
  } catch (e) {
    next(e);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const { refresh } = z
      .object({ refresh: z.string().min(1) })
      .parse(req.body);
    const payload = verifyRefreshToken(refresh);

    const revoked = await prisma.revokedToken.findUnique({
      where: { jti: payload.jti },
    });
    if (revoked)
      return res
        .status(401)
        .json({ error: { message: "Refresh token revoked" } });

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user)
      return res.status(401).json({ error: { message: "User not found" } });

    const access = signAccessToken({
      sub: user.id,
      orgId: user.organisationId,
      branchId: user.branchId || null,
      role: user.role,
    });
    const newRefresh = signRefreshToken({
      sub: user.id,
      orgId: user.organisationId,
      branchId: user.branchId || null,
      role: user.role,
    });

    await prisma.revokedToken.create({
      data: {
        jti: payload.jti,
        type: "refresh",
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
    res.json({ data: { tokens: { access, refresh: newRefresh } } });
  } catch (e) {
    next(e);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const { token, type } = z
      .object({ token: z.string().min(1), type: z.enum(["access", "refresh"]) })
      .parse(req.body);
    const secret =
      type === "refresh"
        ? process.env.JWT_REFRESH_SECRET!
        : process.env.JWT_ACCESS_SECRET!;
    const payload = jwt.verify(token, secret) as any;
    const expSec = Math.max(
      0,
      (payload.exp ?? 0) - Math.floor(Date.now() / 1000),
    );
    await prisma.revokedToken.create({
      data: {
        jti: payload.jti,
        type,
        expiresAt: new Date(Date.now() + expSec * 1000),
      },
    });
    res.json({ data: { ok: true } });
  } catch (e) {
    next(e);
  }
});
