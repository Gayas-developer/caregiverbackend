"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
function errorHandler(err, _req, res, _next) {
    let status = err.status || 500;
    let message = err.message || 'Internal Server Error';
    let details = err.details || undefined;
    // Prisma FK violations (P2003) or raw Prisma error text — never expose internal invocation to client.
    const isPrismaFk = err?.code === 'P2003' ||
        (typeof message === 'string' &&
            (message.includes('Foreign key constraint violated') || message.includes('_fkey')));
    if (isPrismaFk) {
        status = 400;
        message =
            'The selected branch or organisation is invalid or no longer exists. Please refresh the list and try again.';
        details = undefined;
    }
    res.status(status).json({ error: { code: status, message, details } });
}
