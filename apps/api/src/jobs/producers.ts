import { alertQueue } from './queues';
export async function enqueueAlertEmail(alert: any) {
  await alertQueue.add('send-alert-email', { alertId: alert.id }, { attempts: 3 });
}
