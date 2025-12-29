import { Router } from 'express';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope } from '../../utils/auth';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const router = Router();

router.get('/patients.csv', authenticate, tenantScope, async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null };
    const list = await prisma.patient.findMany({
      where: ctx.branchId
        ? { branchId: ctx.branchId }
        : { branch: { organisationId: ctx.orgId } },
      include: { branch: true }
    });
    const header = 'id,firstName,lastName,branchId\n';
    const rows = list.map((p: any) => `${p.id},${p.firstName},${p.lastName},${p.branchId}`).join('\n');
    const csv = header + rows + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="patients.csv"');
    res.send(csv);
  } catch (e) { next(e); }
});

router.get('/patient/:id.pdf', authenticate, tenantScope, async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null };
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id }, include: { branch: true } });
    if (!patient) return res.status(404).send('Not found');
    if (patient.branch.organisationId !== ctx.orgId) return res.status(403).send('Forbidden');
    if (ctx.branchId && patient.branchId !== ctx.branchId) return res.status(403).send('Forbidden');

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const { width, height } = page.getSize();
    const title = `Patient Report: ${patient.firstName} ${patient.lastName}`;
    page.drawText(title, { x: 50, y: height - 80, size: 18, font });
    page.drawText(`Patient ID: ${patient.id}`, { x: 50, y: height - 110, size: 12, font });
    page.drawText(`Branch ID: ${patient.branchId}`, { x: 50, y: height - 130, size: 12, font });
    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="patient-${patient.id}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) { next(e); }
});

router.get('/visit/:id.pdf', authenticate, tenantScope, async (req, res, next) => {
  try {
    const ctx = (req as any).ctx as { orgId: string; branchId: string | null };
    const visit = await prisma.visit.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { include: { branch: true } },
        vitals: { orderBy: { recordedAt: 'asc' } }
      }
    });
    if (!visit) return res.status(404).send('Not found');
    if (visit.patient.branch.organisationId !== ctx.orgId) return res.status(403).send('Forbidden');
    if (ctx.branchId && visit.branchId !== ctx.branchId) return res.status(403).send('Forbidden');

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const { height } = page.getSize();

    const patientName = `${visit.patient.firstName} ${visit.patient.lastName}`;
    page.drawText(`Visit Summary`, { x: 50, y: height - 60, size: 18, font });
    page.drawText(`Visit ID: ${visit.id}`, { x: 50, y: height - 90, size: 12, font });
    page.drawText(`Patient: ${patientName}`, { x: 50, y: height - 110, size: 12, font });
    page.drawText(`Started: ${visit.startedAt.toISOString()}`, { x: 50, y: height - 130, size: 12, font });
    page.drawText(`Status: ${visit.status}`, { x: 50, y: height - 150, size: 12, font });

    let y = height - 190;
    page.drawText('Vitals', { x: 50, y, size: 14, font });
    y -= 20;

    for (const v of visit.vitals) {
      if (y < 60) break;
      const when = v.recordedAt.toISOString();
      let value = '';
      if (v.type === 'BP') value = `${v.systolic ?? ''}/${v.diastolic ?? ''} ${v.unit ?? ''}`.trim();
      else value = `${v.valueNum ?? ''} ${v.unit ?? ''}`.trim();
      page.drawText(`${when}  ${v.type}  ${value}`, { x: 50, y, size: 10, font });
      y -= 14;
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="visit-${visit.id}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    next(e);
  }
});
