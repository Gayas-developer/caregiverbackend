import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { router as auth } from './modules/auth/auth.routes';
import { router as orgs } from './modules/org/org.routes';
import { router as patients } from './modules/patient/patient.routes';
import { router as vitals } from './modules/vitals/vital.routes';
import { router as thresholds } from './modules/thresholds/threshold.routes';
import { router as reports } from './modules/reports/report.routes';
import { router as visits } from './modules/visits/visit.routes';
import { errorHandler } from './utils/error';
import { docs } from './swagger';
import { audit } from './middleware/audit';
import helmet from "helmet";
import rateLimit from "express-rate-limit";


export function createServer() {
  const app = express();

  app.use(helmet());
  app.use(rateLimit({ windowMs: 15*60*1000, max: 500 }));

  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.send('API running ✅'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(docs));

  // Audit mutating requests
  app.use(audit);

  app.use('/v1/auth', auth);
  app.use('/v1/orgs', orgs);
  app.use('/v1/patients', patients);
  app.use('/v1/visits', visits);
  app.use('/v1/vitals', vitals);
  app.use('/v1/thresholds', thresholds);
  app.use('/v1/reports', reports);

  app.use(errorHandler);
  return app;
}
