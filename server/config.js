import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  port: Number(process.env.PORT) || 3000,
  isProd: process.env.NODE_ENV === 'production',
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'shiftly.db'),
  // Demo mode returns the password-reset link in the API response (no mail server needed)
  demoMode: process.env.DEMO_MODE !== 'false',
  session: {
    cookieName: 'sid',
    shortTtlHours: 12,       // without "remember me"
    rememberTtlDays: 30,     // with "remember me"
  },
  login: {
    maxFailedAttempts: 5,
    lockMinutes: 15,
  },
  // RENDER_EXTERNAL_URL is set automatically on Render
  appUrl: process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000',
};
