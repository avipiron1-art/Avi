import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { ah, badRequest } from '../lib/errors.js';
import { validate, z } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import {
  createSnapshot, driveStatus, saveDriveClient, startDriveConnect, disconnectDrive, runDriveBackup,
} from '../services/backup.js';

const router = Router();

router.get('/status', (req, res) => res.json(driveStatus()));

router.put('/drive/config', ah((req, res) => {
  const body = validate(z.object({
    client_id: z.string().trim().min(10, 'Client ID לא תקין').max(200).regex(/\.apps\.googleusercontent\.com$/, 'Client ID צריך להסתיים ב-apps.googleusercontent.com'),
    client_secret: z.string().trim().min(10, 'Client Secret לא תקין').max(200),
  }), req.body);
  saveDriveClient(body.client_id, body.client_secret);
  audit(req, { action: 'backup.drive_config', entityType: 'settings', description: `${req.user.display_name} הגדיר/ה פרטי חיבור ל-Google Drive` });
  res.json({ ...driveStatus(), message: 'הפרטים נשמרו. עכשיו לחצו "חיבור ל-Google Drive"' });
}));

router.post('/drive/connect', ah(async (req, res) => {
  try {
    const pending = await startDriveConnect(req);
    res.json({ pending });
  } catch (e) { throw badRequest(e.message); }
}));

router.post('/drive/disconnect', ah((req, res) => {
  disconnectDrive();
  audit(req, { action: 'backup.drive_disconnected', entityType: 'settings', description: `${req.user.display_name} ניתק/ה את הגיבוי ל-Google Drive` });
  res.json({ ...driveStatus(), message: 'הגיבוי ל-Google Drive נותק' });
}));

router.post('/run', ah(async (req, res) => {
  try {
    const r = await runDriveBackup();
    audit(req, { action: 'backup.run', entityType: 'settings', description: `${req.user.display_name} הריץ/ה גיבוי ל-Google Drive (${r.name})` });
    res.json({ ...driveStatus(), message: `הגיבוי נשמר ב-Google Drive (${Math.round(r.size / 1024)}KB)` });
  } catch (e) { throw badRequest(e.message); }
}));

// Full database download (contains all business data – admin only)
router.get('/download', ah(async (req, res) => {
  const snap = await createSnapshot();
  audit(req, { action: 'backup.download', entityType: 'settings', description: `${req.user.display_name} הוריד/ה גיבוי מלא של המערכת` });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${snap.name}"`);
  res.setHeader('Content-Length', snap.size);
  fs.createReadStream(snap.file).on('close', () => fs.rmSync(path.dirname(snap.file), { recursive: true, force: true })).pipe(res);
}));

export default router;
