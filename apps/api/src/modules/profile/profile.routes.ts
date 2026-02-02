import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../../utils/prisma";
import { authenticate, tenantScope, JwtPayload } from "../../utils/auth";

export const router = Router();

router.get("/me", authenticate, tenantScope, async (req, res, next) => {
  try {
    const user = (req as any).user as JwtPayload;
    const ctx = (req as any).ctx as { orgId: string };

    const me = await prisma.user.findFirst({
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
  } catch (e) {
    next(e);
  }
});

const updateProfileSchema = z.object({
  displayName: z.string().min(2).max(80).optional(),
  // later you can add phone/avatarUrl etc
});

router.patch("/me", authenticate, tenantScope, async (req, res, next) => {
  try {
    const user = (req as any).user as JwtPayload;
    const ctx = (req as any).ctx as { orgId: string };
    const data = updateProfileSchema.parse(req.body);

    // ensure user belongs to org (defensive)
    const exists = await prisma.user.findFirst({
      where: { id: user.sub, organisationId: ctx.orgId },
      select: { id: true },
    });
    if (!exists)
      return res.status(404).json({ error: { message: "User not found" } });

    const updated = await prisma.user.update({
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
  } catch (e) {
    next(e);
  }
});
const changePasswordSchema = z.object({
  oldPassword: z.string().min(6),
  newPassword: z.string().min(6),
});

router.post("/change-password", authenticate, async (req, res, next) => {
  try {
    const user = (req as any).user as JwtPayload;
    const { oldPassword, newPassword } = changePasswordSchema.parse(req.body);

    const dbUser = await prisma.user.findUnique({
      where: { id: user.sub },
    });

    if (!dbUser) {
      return res.status(404).json({ error: { message: "User not found" } });
    }

    const ok = await bcrypt.compare(oldPassword, dbUser.passwordHash);
    if (!ok) {
      return res
        .status(400)
        .json({ error: { message: "Incorrect old password" } });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.sub },
      data: { passwordHash: hash },
    });

    res.json({ data: { message: "Password updated successfully" } });
  } catch (e) {
    next(e);
  }
});
