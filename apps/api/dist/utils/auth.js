"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.signRefreshToken = signRefreshToken;
exports.verifyRefreshToken = verifyRefreshToken;
exports.revokeToken = revokeToken;
exports.isTokenRevoked = isTokenRevoked;
exports.authenticate = authenticate;
exports.tenantScope = tenantScope;
exports.requireRole = requireRole;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("./prisma");
function signAccessToken(payload) {
    const secret = process.env.JWT_ACCESS_SECRET;
    const jti = crypto_1.default.randomUUID();
    return jsonwebtoken_1.default.sign({ ...payload, type: 'access', jti }, secret, { expiresIn: '15m' });
}
function signRefreshToken(payload) {
    const secret = process.env.JWT_REFRESH_SECRET;
    const jti = crypto_1.default.randomUUID();
    return jsonwebtoken_1.default.sign({ ...payload, type: 'refresh', jti }, secret, { expiresIn: '7d' });
}
function verifyRefreshToken(token) {
    const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_REFRESH_SECRET);
    return payload;
}
async function revokeToken(jti, type, expSeconds) {
    const expiresAt = new Date(Date.now() + expSeconds * 1000);
    await prisma_1.prisma.revokedToken.create({ data: { jti, type, expiresAt } });
}
async function isTokenRevoked(jti) {
    const found = await prisma_1.prisma.revokedToken.findUnique({ where: { jti } });
    return !!found;
}
function authenticate(req, _res, next) {
    (async () => {
        try {
            const auth = req.headers.authorization || '';
            const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
            if (!token)
                throw Object.assign(new Error('Unauthorized'), { status: 401 });
            const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_ACCESS_SECRET);
            if (payload.type !== 'access')
                throw Object.assign(new Error('Unauthorized'), { status: 401 });
            const revoked = await isTokenRevoked(payload.jti);
            if (revoked)
                throw Object.assign(new Error('Unauthorized'), { status: 401 });
            req.user = payload;
            next();
        }
        catch {
            next(Object.assign(new Error('Unauthorized'), { status: 401 }));
        }
    })();
}
function tenantScope(req, _res, next) {
    const user = req.user;
    if (!user?.orgId)
        return next(Object.assign(new Error('ORG_CONTEXT_MISSING'), { status: 400 }));
    req.ctx = { orgId: user.orgId, branchId: user.branchId || null, role: user.role };
    next();
}
function requireRole(...roles) {
    return (req, _res, next) => {
        const role = req.ctx?.role;
        if (!role || !roles.includes(role))
            return next(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
        next();
    };
}
