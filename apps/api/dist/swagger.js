"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.docs = void 0;
exports.docs = {
    openapi: '3.0.0',
    info: { title: 'Caregiver Platform API', version: '1.0.0' },
    paths: {
        '/health': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
        '/v1/auth/register': { post: { summary: 'Register user', responses: { '201': { description: 'Created' } } } },
        '/v1/auth/login': { post: { summary: 'Login', responses: { '200': { description: 'OK' } } } },
        '/v1/auth/forgot-password': { post: { summary: 'Request password reset OTP', responses: { '200': { description: 'OK' } } } },
        '/v1/auth/verify-reset-otp': { post: { summary: 'Verify password reset OTP', responses: { '200': { description: 'OK' } } } },
        '/v1/auth/reset-password': { post: { summary: 'Reset password', responses: { '200': { description: 'OK' } } } },
        '/v1/auth/refresh': { post: { summary: 'Refresh tokens', responses: { '200': { description: 'OK' } } } },
        '/v1/patients': { get: { summary: 'List patients', responses: { '200': { description: 'OK' } } } },
        '/v1/vitals': { post: { summary: 'Create vital reading', responses: { '201': { description: 'Created' } } } },
        '/v1/reports/patients.csv': { get: { summary: 'CSV export', responses: { '200': { description: 'OK' } } } }
    }
};
