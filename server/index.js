import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { getDb } from './db/index.js';
import { authenticate, requireAuth, requirePerm, csrf } from './middleware/auth.js';
import { AppError } from './lib/errors.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import employeeRoutes from './routes/employees.js';
import shiftRoutes from './routes/shifts.js';
import attendanceRoutes from './routes/attendance.js';
import taskRoutes from './routes/tasks.js';
import requestRoutes from './routes/requests.js';
import notificationRoutes from './routes/notifications.js';
import reportRoutes from './routes/reports.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';
import scheduleRoutes from './routes/schedule.js';
import backupRoutes from './routes/backup.js';
import calendarRoutes from './routes/calendar.js';
import swapRoutes from './routes/swaps.js';
import announcementRoutes from './routes/announcements.js';
import { invitesRouter, joinRouter } from './routes/invites.js';
import { seedIfEmpty } from './db/seed.js';
import { startJobs } from './services/jobs.js';
import { initPush } from './services/push.js';
import { getSetting } from './services/settings.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
  }));
  app.use(express.json({ limit: '600kb' }));
  app.use(cookieParser());
  app.use(authenticate);

  const api = express.Router();
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Health check for uptime monitoring: also proves the database answers.
  api.get('/health', (req, res) => {
    try { getDb().prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
  // Public branding (login page, installed app) – no secrets here.
  api.get('/branding', (req, res) => res.json({ business_name: getSetting('business_name'), logo: getSetting('logo') || '', brand_color: getSetting('brand_color') || '' }));
  api.use('/auth', authRoutes); // login / forgot / reset are rate-limited and need no CSRF token
  api.use('/join', joinRouter); // public: new employees sign up with an invite link
  api.use(requireAuth, csrf);
  api.use('/dashboard', dashboardRoutes);
  api.use('/employees', employeeRoutes);
  api.use('/shifts', shiftRoutes);
  api.use('/attendance', attendanceRoutes);
  api.use('/tasks', taskRoutes);
  api.use('/requests', requestRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/reports', requirePerm('reports.view'), reportRoutes);
  api.use('/search', searchRoutes);
  api.use('/schedule', scheduleRoutes);
  api.use('/backup', requirePerm('users.manage'), backupRoutes);
  api.use('/invites', invitesRouter);
  api.use('/calendar', calendarRoutes);
  api.use('/swaps', swapRoutes);
  api.use('/announcements', announcementRoutes);
  api.use('/', adminRoutes);
  api.use((req, res) => res.status(404).json({ error: 'הכתובת המבוקשת לא נמצאה' }));
  app.use('/api', api);

  // Serve the built SPA
  const dist = path.join(config.root, 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, file) => {
        // The service worker and manifest must always be re-checked so app updates arrive immediately
        if (/(sw\.js|manifest\.webmanifest|offline\.html)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
        if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
        // Hashed build assets never change
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html')); });
  }

  // Central error handler: friendly messages to the user, details only in server logs
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'הבקשה אינה תקינה' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'הקובץ או הנתונים גדולים מדי' });
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return res.status(400).json({ error: 'אחד הערכים שנבחרו אינו קיים במערכת' });
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'הנתונים אינם תקינים' });
    console.error(err);
    res.status(500).json({ error: 'אירעה שגיאה בלתי צפויה. נסו שוב בעוד רגע.' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  getDb();
  seedIfEmpty();
  initPush();
  startJobs();
  createApp().listen(config.port, () => {
    console.log(`✅ Shiftly running on http://localhost:${config.port}`);
  });
}
