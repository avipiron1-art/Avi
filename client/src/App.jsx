import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import { EmptyState, SkeletonPage } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';

// Every other screen loads only when it's opened (smaller first download → faster start on phones).
// After the app is up, they are fetched quietly in the background so moving between screens stays instant.
const loaders = {
  PasswordReset: () => import('./pages/PasswordReset.jsx'),
  Employees: () => import('./pages/Employees.jsx'),
  EmployeeProfile: () => import('./pages/EmployeeProfile.jsx'),
  Shifts: () => import('./pages/Shifts.jsx'),
  Attendance: () => import('./pages/Attendance.jsx'),
  Tasks: () => import('./pages/Tasks.jsx'),
  Requests: () => import('./pages/Requests.jsx'),
  Availability: () => import('./pages/Availability.jsx'),
  Schedule: () => import('./pages/Schedule.jsx'),
  Join: () => import('./pages/Join.jsx'),
  Reports: () => import('./pages/Reports.jsx'),
  MyHours: () => import('./pages/MyHours.jsx'),
  Announcements: () => import('./pages/Announcements.jsx'),
  Notifications: () => import('./pages/Notifications.jsx'),
  Settings: () => import('./pages/Settings.jsx'),
  Charts: () => import('./components/Charts.jsx'),
};
const Employees = lazy(loaders.Employees);
const EmployeeProfile = lazy(loaders.EmployeeProfile);
const Shifts = lazy(loaders.Shifts);
const Attendance = lazy(loaders.Attendance);
const Tasks = lazy(loaders.Tasks);
const Requests = lazy(loaders.Requests);
const Availability = lazy(loaders.Availability);
const Schedule = lazy(loaders.Schedule);
const Join = lazy(loaders.Join);
const Reports = lazy(loaders.Reports);
const MyHours = lazy(loaders.MyHours);
const Announcements = lazy(loaders.Announcements);
const Notifications = lazy(loaders.Notifications);
const SettingsPage = lazy(loaders.Settings);
const ForgotPassword = lazy(() => loaders.PasswordReset().then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => loaders.PasswordReset().then((m) => ({ default: m.ResetPassword })));

/** Fetch the remaining screens once the browser is idle. */
function usePrefetch(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    const cancel = window.cancelIdleCallback || clearTimeout;
    const id = idle(() => Object.values(loaders).forEach((load) => load().catch(() => {})));
    return () => cancel(id);
  }, [enabled]);
}

/** Client-side guard for UX only – the server enforces every permission independently. */
function Guard({ perm, employee, children }) {
  const { can, user } = useAuth();
  if ((perm && !can(...perm)) || (employee && !user.employee_id)) {
    return <div className="card"><EmptyState icon={ShieldAlert} title="אין לך הרשאה לצפות בעמוד זה" text="אם לדעתך זו טעות, פנו למנהל המערכת." /></div>;
  }
  return children;
}

export default function App() {
  const { user } = useAuth();
  const location = useLocation();
  usePrefetch(!!user);

  if (user === undefined) return <div className="content"><SkeletonPage /></div>;

  if (!user) {
    return (
      <Suspense fallback={<div className="content"><SkeletonPage /></div>}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname + location.search }} />} />
      </Routes>
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<div className="content"><SkeletonPage /></div>}>
    <Routes>
      <Route path="/login" element={<Navigate to={location.state?.from || '/'} replace />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/join/:token" element={<Join />} />
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="employees" element={<Guard perm={['employees.view']}><Employees /></Guard>} />
        <Route path="employees/:id" element={<EmployeeProfile />} />
        <Route path="shifts" element={<Shifts />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="requests" element={<Requests />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="availability" element={<Guard employee><Availability /></Guard>} />
        <Route path="reports" element={<Guard perm={['reports.view']}><Reports /></Guard>} />
        <Route path="my-hours" element={<MyHours />} />
        <Route path="announcements" element={<Announcements />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<div className="card"><EmptyState title="העמוד לא נמצא" text="ייתכן שהקישור שגוי או שהעמוד הוסר." action={<a className="btn btn-primary" href="/">חזרה לדף הבית</a>} /></div>} />
      </Route>
    </Routes>
    </Suspense>
  );
}
