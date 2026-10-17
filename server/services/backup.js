// Backups: a consistent snapshot of the SQLite database, gzip-compressed.
// Off-site copies go to the owner's Google Drive using the OAuth "device" flow
// (enter a short code on google.com/device – works from a phone, no browser on the server needed).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { getDb } from '../db/index.js';
import { getSetting, updateSettings } from './settings.js';
import { nowLocal } from '../lib/time.js';
import { audit } from './audit.js';
import { notifyPermission } from './notify.js';

const OAUTH = process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com';
const DRIVE = process.env.GOOGLE_DRIVE_BASE || 'https://www.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file'; // only files this app creates
const FOLDER_NAME = 'Shiftly Backups';

/** Create a compressed snapshot and return { file, name, size }. Caller deletes the temp file. */
export async function createSnapshot() {
  const stamp = nowLocal().replace(/[:T]/g, '-');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shiftly-backup-')), 'shiftly.db');
  await getDb().backup(tmp);
  const name = `shiftly-${stamp}.db.gz`;
  const gz = `${tmp}.gz`;
  fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }));
  fs.rmSync(tmp, { force: true });
  return { file: gz, name, size: fs.statSync(gz).size };
}

// ---------------- Google OAuth (device flow) ----------------
let pendingAuth = null; // { user_code, verification_url, expires_at, error }

async function postForm(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function driveStatus() {
  return {
    configured: !!(getSetting('gdrive_client_id') && getSetting('gdrive_client_secret')),
    connected: !!getSetting('gdrive_refresh_token'),
    client_id: getSetting('gdrive_client_id') || '',
    account: getSetting('gdrive_account') || null,
    last_backup: getSetting('gdrive_last_backup') || null,
    last_error: getSetting('gdrive_last_error') || null,
    pending: pendingAuth && pendingAuth.expires_at > Date.now()
      ? { user_code: pendingAuth.user_code, verification_url: pendingAuth.verification_url, error: pendingAuth.error || null } : null,
    keep: Number(getSetting('backup_keep')) || 30,
  };
}

export function saveDriveClient(clientId, clientSecret) {
  updateSettings({ gdrive_client_id: clientId, gdrive_client_secret: clientSecret });
}

/** Start the device flow; polls Google in the background until the user approves. */
export async function startDriveConnect(req) {
  const clientId = getSetting('gdrive_client_id');
  const clientSecret = getSetting('gdrive_client_secret');
  if (!clientId || !clientSecret) throw new Error('יש להזין קודם Client ID ו-Client Secret');
  const r = await postForm(`${OAUTH}/device/code`, { client_id: clientId, scope: SCOPE });
  if (!r.ok) throw new Error(`Google דחה את הבקשה: ${r.data.error_description || r.data.error || r.status}. בדקו שה-Client הוא מסוג "TVs and Limited Input devices".`);
  const { device_code: deviceCode, user_code: userCode, verification_url: url, interval = 5, expires_in: expiresIn = 1800 } = r.data;
  pendingAuth = { user_code: userCode, verification_url: url, expires_at: Date.now() + expiresIn * 1000 };
  const actor = { user: req.user, ip: req.ip };

  (async () => {
    let wait = interval;
    while (pendingAuth && pendingAuth.user_code === userCode && Date.now() < pendingAuth.expires_at) {
      await new Promise((res) => setTimeout(res, wait * 1000));
      const t = await postForm(`${OAUTH}/token`, {
        client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).catch(() => ({ ok: false, data: { error: 'network' } }));
      if (t.ok && t.data.refresh_token) {
        updateSettings({ gdrive_refresh_token: t.data.refresh_token, gdrive_folder_id: '', gdrive_last_error: '' });
        pendingAuth = null;
        audit(actor, { action: 'backup.drive_connected', entityType: 'settings', description: `${actor.user.display_name} חיבר/ה גיבוי ל-Google Drive` });
        runDriveBackup().catch(() => {});
        return;
      }
      const err = t.data.error;
      if (err === 'slow_down') wait += 5;
      else if (err !== 'authorization_pending' && err !== 'network') { if (pendingAuth) pendingAuth.error = t.data.error_description || err; return; }
    }
  })();
  return driveStatus().pending;
}

export function disconnectDrive() {
  pendingAuth = null;
  updateSettings({ gdrive_refresh_token: '', gdrive_folder_id: '', gdrive_account: '' });
}

async function accessToken() {
  const r = await postForm(`${OAUTH}/token`, {
    client_id: getSetting('gdrive_client_id'), client_secret: getSetting('gdrive_client_secret'),
    refresh_token: getSetting('gdrive_refresh_token'), grant_type: 'refresh_token',
  });
  if (!r.ok) throw new Error(r.data.error === 'invalid_grant' ? 'החיבור ל-Google Drive פג או בוטל. יש לחבר מחדש.' : `שגיאת התחברות ל-Google (${r.data.error || r.status})`);
  return r.data.access_token;
}

async function driveFetch(token, url, opts = {}) {
  const res = await fetch(`${DRIVE}${url}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`שגיאה מ-Google Drive (${res.status})`);
  return res.status === 204 ? null : res.json();
}

async function ensureFolder(token) {
  let id = getSetting('gdrive_folder_id');
  if (id) return id;
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await driveFetch(token, `/drive/v3/files?q=${q}&fields=files(id)`);
  id = found.files?.[0]?.id;
  if (!id) {
    const created = await driveFetch(token, '/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    id = created.id;
  }
  updateSettings({ gdrive_folder_id: id });
  return id;
}

let running = false;

/** Upload a fresh snapshot to Drive and delete the oldest copies beyond `backup_keep`. */
export async function runDriveBackup() {
  if (!getSetting('gdrive_refresh_token')) throw new Error('Google Drive לא מחובר');
  if (running) throw new Error('גיבוי כבר מתבצע כעת');
  running = true;
  const snap = await createSnapshot();
  try {
    const token = await accessToken();
    const folder = await ensureFolder(token);
    const boundary = `shiftly${Date.now()}`;
    const meta = JSON.stringify({ name: snap.name, parents: [folder] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`),
      fs.readFileSync(snap.file),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    await driveFetch(token, '/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    // retention
    const keep = Number(getSetting('backup_keep')) || 30;
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
    const list = await driveFetch(token, `/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name)&pageSize=200`);
    for (const f of (list.files || []).slice(keep)) await driveFetch(token, `/drive/v3/files/${f.id}`, { method: 'DELETE' }).catch(() => {});
    updateSettings({ gdrive_last_backup: new Date().toISOString(), gdrive_last_error: '' });
    return { name: snap.name, size: snap.size };
  } catch (e) {
    updateSettings({ gdrive_last_error: `${new Date().toISOString()} ${e.message}` });
    throw e;
  } finally {
    running = false;
    fs.rmSync(path.dirname(snap.file), { recursive: true, force: true });
  }
}

/** Called every minute by the job runner: one Drive backup per day after 03:00 local time. */
export function maybeDailyBackup() {
  if (!getSetting('gdrive_refresh_token') || running) return;
  const last = getSetting('gdrive_last_backup');
  const lastErr = getSetting('gdrive_last_error') || '';
  if (nowLocal().slice(11, 16) < '03:00') return;
  if (last && new Date(last).getTime() > Date.now() - 20 * 3600 * 1000) return;
  // after a failure wait an hour before retrying
  const errAt = Date.parse(lastErr.split(' ')[0]);
  if (errAt && errAt > Date.now() - 3600 * 1000) return;
  runDriveBackup().catch((e) => {
    console.error('[backup]', e.message);
    notifyPermission('users.manage', { type: 'backup_failed', title: 'הגיבוי הלילי ל-Google Drive נכשל', body: e.message, link: '/settings?tab=backup', email: true });
  });
}
