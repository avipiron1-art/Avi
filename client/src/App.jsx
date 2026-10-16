import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import { EmptyState, SkeletonPage } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import { ForgotPassword, ResetPassword } from './pages/PasswordReset.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Employees from './pages/Employees.jsx';
import EmployeeProfile from './pages/EmployeeProfile.jsx';
import Shifts from './pages/Shifts.jsx';
import Attendance from './pages/Attendance.jsx';
import Tasks from './pages/Tasks.jsx';
import Requests from './pages/Requests.jsx';
import Availability from './pages/Availability.jsx';
import Reports from './pages/Reports.jsx';
import Notifications from './pages/Notifications.jsx';
import SettingsPage from './pages/Settings.jsx';

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

  if (user === undefined) return <div className="content"><SkeletonPage /></div>;

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname + location.search }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to={location.state?.from || '/'} replace />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="employees" element={<Guard perm={['employees.view']}><Employees /></Guard>} />
        <Route path="employees/:id" element={<EmployeeProfile />} />
        <Route path="shifts" element={<Shifts />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="requests" element={<Requests />} />
        <Route path="availability" element={<Guard employee><Availability /></Guard>} />
        <Route path="reports" element={<Guard perm={['reports.view']}><Reports /></Guard>} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<div className="card"><EmptyState title="העמוד לא נמצא" text="ייתכן שהקישור שגוי או שהעמוד הוסר." action={<a className="btn btn-primary" href="/">חזרה לדף הבית</a>} /></div>} />
      </Route>
    </Routes>
  );
}
