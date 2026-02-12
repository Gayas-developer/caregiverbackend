"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueAlertEmail = enqueueAlertEmail;
const queues_1 = require("./queues");
async function enqueueAlertEmail(alert) {
    await queues_1.alertQueue.add('send-alert-email', { alertId: alert.id }, { attempts: 3 });
}
