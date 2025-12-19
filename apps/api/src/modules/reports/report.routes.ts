import { Router } from 'express';
import { prisma } from '../../utils/prisma';
import { authenticate, tenantScope } from '../../utils/auth';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const router = Router();

router.get('/patients.csv', authenticate, tenantScope, async (req, res, next) => {
  try {
    const { branchId } = (req as any).ctx;
    const list = await prisma.patient.findMany({ where: branchId ? { branchId } : undefined });
    const header = 'id,firstName,lastName,branchId\n';
    const rows = list.map(p => `${p.id},${p.firstName},${p.lastName},${p.branchId}`).join('\n');
    const csv = header + rows + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="patients.csv"');
    res.send(csv);
  } catch (e) { next(e); }
});

router.get('/patient/:id.pdf', authenticate, tenantScope, async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).send('Not found');

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
