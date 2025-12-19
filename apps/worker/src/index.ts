import dotenv from 'dotenv';
dotenv.config();
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';

const logger = pino({ level: 'info' });
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
const prisma = new PrismaClient();

new Worker('alerts', async job => {
  if (job.name === 'send-alert-email') {
    const alert = await prisma.alert.findUnique({ where: { id: job.data.alertId } });
    if (!alert) return;
    // Mock email send
    logger.info({ alertId: alert.id, message: alert.message }, 'Sending alert email');
  }
}, { connection });

logger.info('Worker up ✅');
