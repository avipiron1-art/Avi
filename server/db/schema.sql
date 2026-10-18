-- =====================================================================
-- Shiftly – workforce management schema (SQLite)
-- Times are stored as local business time ISO strings: 'YYYY-MM-DDTHH:MM'
-- (timezone configured in settings). Dates: 'YYYY-MM-DD'.
-- =====================================================================
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,              -- admin / shift_manager / employee, or custom_xxx for roles the business adds
  name        TEXT NOT NULL,
  description TEXT,
  -- Who the role's permissions apply to: all | branch | branches | department | department_all | lead | self
  scope       TEXT NOT NULL DEFAULT 'branch'
);

-- Permissions granted to each role (admin implicitly has all permissions)
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- Branches / sites. Ready for multi-branch support.
CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  address    TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Job positions ("תפקיד")
CREATE TABLE IF NOT EXISTS positions (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE CHECK (length(employee_code) BETWEEN 1 AND 20),
  first_name    TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 60),
  last_name     TEXT NOT NULL CHECK (length(last_name) BETWEEN 1 AND 60),
  phone         TEXT,
  email         TEXT UNIQUE COLLATE NOCASE,
  avatar        TEXT,                       -- data:image/... (validated) or NULL -> initials
  position_id   INTEGER REFERENCES positions(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  start_date    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','vacation')),
  hourly_wage   REAL CHECK (hourly_wage IS NULL OR hourly_wage >= 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_position   ON employees(position_id);
CREATE INDEX IF NOT EXISTS idx_employees_status     ON employees(status);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 3 AND 40),
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role_id         INTEGER NOT NULL REFERENCES roles(id),
  employee_id     INTEGER UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remember    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employee_notes (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content     TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_employee ON employee_notes(employee_id);

CREATE TABLE IF NOT EXISTS shifts (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_at    TEXT NOT NULL,                -- 'YYYY-MM-DDTHH:MM'
  end_at      TEXT NOT NULL,
  position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL,  -- role within the shift
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  late_notified INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_shifts_employee_start ON shifts(employee_id, start_at);
CREATE INDEX IF NOT EXISTS idx_shifts_start ON shifts(start_at);

-- Actual attendance. Planned times are read from the linked shift (no duplication).
CREATE TABLE IF NOT EXISTS attendance (
  id            INTEGER PRIMARY KEY,
  shift_id      INTEGER NOT NULL UNIQUE REFERENCES shifts(id) ON DELETE CASCADE,
  clock_in_at   TEXT,
  clock_out_at  TEXT,
  marked_absent INTEGER NOT NULL DEFAULT 0 CHECK (marked_absent IN (0,1)),
  note          TEXT,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (clock_out_at IS NULL OR clock_in_at IS NULL OR clock_out_at >= clock_in_at)
);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY,
  shift_id    INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT,
  severity    TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incidents_occurred ON incidents(occurred_at);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 150),
  description TEXT,
  assignee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date    TEXT,
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','done','cancelled')),
  due_notified INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);

CREATE TABLE IF NOT EXISTS requests (
  id               INTEGER PRIMARY KEY,
  employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('vacation','day_off','shift_swap','availability','general')),
  start_date       TEXT NOT NULL,
  end_date         TEXT,
  shift_id         INTEGER REFERENCES shifts(id) ON DELETE SET NULL,     -- for shift swap
  swap_with_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,  -- for shift swap
  details          TEXT NOT NULL CHECK (length(details) BETWEEN 1 AND 2000),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  manager_response TEXT,
  reviewed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_requests_employee ON requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_requests_status   ON requests(status);

-- Weekly availability reported by the employee
CREATE TABLE IF NOT EXISTS availability (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  available   INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  from_time   TEXT,
  to_time     TEXT,
  note        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, weekday)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER,             -- intentionally no FK: the log must outlive deleted users
  user_name   TEXT,                -- snapshot: keeps history readable after user deletion
  action      TEXT NOT NULL,       -- e.g. shift.update
  entity_type TEXT,
  entity_id   INTEGER,
  description TEXT NOT NULL,
  old_value   TEXT,                -- JSON
  new_value   TEXT,                -- JSON
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs(entity_type, entity_id);

-- Audit log is append-only: enforced at the database level.
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- =====================================================================
-- Preference-based scheduling
-- =====================================================================

-- Shift templates defined by an authorized manager (e.g. Morning 07:00–15:00)
CREATE TABLE IF NOT EXISTS shift_types (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  start_time  TEXT NOT NULL,          -- 'HH:MM'
  end_time    TEXT NOT NULL,          -- 'HH:MM' (<= start_time means it ends the next day)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An employee's submission for a week (who submitted, general note)
CREATE TABLE IF NOT EXISTS schedule_submissions (
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  week_start   TEXT NOT NULL,         -- Sunday 'YYYY-MM-DD'
  note         TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, week_start)
);

-- Per day + shift type preference
CREATE TABLE IF NOT EXISTS shift_preferences (
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  shift_type_id INTEGER NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  preference    TEXT NOT NULL CHECK (preference IN ('preferred','available','unavailable')),
  PRIMARY KEY (employee_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS idx_prefs_date ON shift_preferences(date);

-- Week planning state
CREATE TABLE IF NOT EXISTS schedule_weeks (
  week_start   TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  published_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Draft assignments made on the scheduling board (become shifts when published)
CREATE TABLE IF NOT EXISTS schedule_assignments (
  date          TEXT NOT NULL,
  shift_type_id INTEGER NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  is_lead       INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0,1)),   -- אחמ"ש
  PRIMARY KEY (date, shift_type_id, employee_id)
);

-- Per-user permission overrides on top of the role's permissions
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted    INTEGER NOT NULL CHECK (granted IN (0,1)),  -- 1 = grant, 0 = revoke
  PRIMARY KEY (user_id, permission)
);

-- =====================================================================
-- v3: push, invites, staffing, swaps, announcements, passkeys
-- =====================================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Join links for new employees
CREATE TABLE IF NOT EXISTS invites (
  id            INTEGER PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  position_id   INTEGER REFERENCES positions(id) ON DELETE SET NULL,
  location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  max_uses      INTEGER NOT NULL DEFAULT 1,
  uses          INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-day override of how many workers / shift leads a shift needs
CREATE TABLE IF NOT EXISTS slot_overrides (
  date             TEXT NOT NULL,
  shift_type_id    INTEGER NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  required_workers INTEGER NOT NULL CHECK (required_workers >= 0),
  required_leads   INTEGER NOT NULL CHECK (required_leads >= 0),
  location_id      INTEGER NOT NULL DEFAULT 0,      -- branch (0 = every branch)
  PRIMARY KEY (date, shift_type_id, location_id)
);

-- Shift swap board
CREATE TABLE IF NOT EXISTS shift_swaps (
  id          INTEGER PRIMARY KEY,
  shift_id    INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  offered_by  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  taken_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','taken','approved','rejected','cancelled')),
  decided_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_swaps_status ON shift_swaps(status);

-- Announcements board
CREATE TABLE IF NOT EXISTS announcements (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body          TEXT,
  urgency       TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','critical')),
  requires_ack  INTEGER NOT NULL DEFAULT 0 CHECK (requires_ack IN (0,1)),   -- pops up until acknowledged
  location_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,      -- NULL = all branches
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,    -- NULL = all departments
  expires_at    TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT NOT NULL DEFAULT (datetime('now')),
  acked_at        TEXT,
  PRIMARY KEY (announcement_id, user_id)
);

-- Fingerprint / Face ID login (WebAuthn passkeys)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,      -- base64url
  public_key    TEXT NOT NULL,             -- base64url
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  name          TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =====================================================================
-- v4: responsibility scopes for a chain of branches
-- =====================================================================
-- Branches a manager is responsible for (roles with scope 'branches', e.g. an area manager)
CREATE TABLE IF NOT EXISTS user_locations (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);
-- Extra branches an employee also works in (besides employees.location_id)
CREATE TABLE IF NOT EXISTS employee_locations (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_employee_locations_loc ON employee_locations(location_id);
-- Week planning state per branch (location_id 0 = business without branches)
CREATE TABLE IF NOT EXISTS schedule_branch_weeks (
  week_start   TEXT NOT NULL,
  location_id  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (week_start, location_id)
);
