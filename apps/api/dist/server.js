"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const auth_routes_1 = require("./modules/auth/auth.routes");
const org_routes_1 = require("./modules/org/org.routes");
const patient_routes_1 = require("./modules/patient/patient.routes");
const vital_routes_1 = require("./modules/vitals/vital.routes");
const threshold_routes_1 = require("./modules/thresholds/threshold.routes");
const report_routes_1 = require("./modules/reports/report.routes");
const visit_routes_1 = require("./modules/visits/visit.routes");
const error_1 = require("./utils/error");
const swagger_1 = require("./swagger");
const audit_1 = require("./middleware/audit");
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const profile_routes_1 = require("./modules/profile/profile.routes");
function createServer() {
    const app = (0, express_1.default)();
    app.use((0, helmet_1.default)());
    app.use((0, express_rate_limit_1.default)({ windowMs: 15 * 60 * 1000, max: 500 }));
    app.use((0, cors_1.default)());
    app.use(express_1.default.json());
    app.get('/health', (_req, res) => res.send('API running ✅'));
    app.use('/docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.docs));
    // Audit mutating requests
    app.use(audit_1.audit);
    app.use('/v1/auth', auth_routes_1.router);
    app.use('/v1/orgs', org_routes_1.router);
    app.use('/v1/patients', patient_routes_1.router);
    app.use('/v1/visits', visit_routes_1.router);
    app.use('/v1/vitals', vital_routes_1.router);
    app.use('/v1/thresholds', threshold_routes_1.router);
    app.use('/v1/reports', report_routes_1.router);
    app.use('/v1/profile', profile_routes_1.router);
    app.use(error_1.errorHandler);
    return app;
}
