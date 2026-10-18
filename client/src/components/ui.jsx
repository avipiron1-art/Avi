import { useContext, useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, Inbox, Loader2, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react';
import { HeaderSlot } from '../lib/headerSlot.js';

// ---------- Button ----------
export function Button({ variant = 'default', size, loading, icon: Icon, children, className = '', block, ...rest }) {
  const cls = ['btn', variant !== 'default' && `btn-${variant}`, size && `btn-${size}`, block && 'btn-block', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 size={16} className="spin" /> : Icon ? <Icon size={size === 'sm' ? 15 : 17} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, size = 18, className = '', small, ...rest }) {
  return (
    <button type="button" className={`icon-btn ${small ? 'sm' : ''} ${className}`} aria-label={label} title={label} {...rest}>
      <Icon size={size} />
    </button>
  );
}

// ---------- Badge ----------
export function Badge({ tone = 'neutral', dot, children }) {
  return <span className={`badge tone-${tone}`}>{dot && <span className="dot" />}{children}</span>;
}

export function StatusBadge({ map, value, dot = true }) {
  const s = map[value];
  if (!s) return null;
  return <Badge tone={s.tone} dot={dot}>{s.label}</Badge>;
}

// ---------- Avatar ----------
const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b'];
export function Avatar({ name = '', src, size = 36 }) {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('');
  const color = COLORS[[...name].reduce((t, c) => t + c.charCodeAt(0), 0) % COLORS.length];
  if (src) return <img className="avatar" src={src} alt={name} width={size} height={size} style={{ width: size, height: size }} />;
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: size * 0.38 }} aria-label={name}>
      {initials}
    </span>
  );
}

export function Person({ name, sub, avatar, size = 36 }) {
  return (
    <div className="person">
      <Avatar name={name} src={avatar} size={size} />
      <div style={{ minWidth: 0 }}>
        <div className="person-name">{name}</div>
        {sub && <div className="person-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ---------- Card ----------
export function Card({ title, icon: Icon, actions, children, pad, className = '', bodyClass = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          <h2>{Icon && <Icon size={18} className="muted" />}{title}</h2>
          {actions && <div className="flex">{actions}</div>}
        </div>
      )}
      <div className={pad === false ? bodyClass : `card-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function KpiCard({ label, value, icon: Icon, tone = 'primary', hint, to, onClick }) {
  const inner = (
    <>
      {Icon && <span className={`kpi-icon tone-${tone}`}><Icon size={19} /></span>}
      <div className="kpi-value">{value ?? '—'}</div>
      <span className="kpi-label">{label}</span>
      {hint && <div className="subtle">{hint}</div>}
    </>
  );
  if (to) return <a href={to} onClick={onClick} className="card kpi kpi-link">{inner}</a>;
  return <div className="card kpi">{inner}</div>;
}

export function PageHeader({ title, subtitle, actions, eyebrow }) {
  const bell = useContext(HeaderSlot);
  return (
    <div className="page-header">
      <div>
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p className="muted" style={{ marginTop: 4 }}>{subtitle}</p>}
      </div>
      {(actions || bell) && <div className="actions">{actions}{bell && <div className="header-bell">{bell}</div>}</div>}
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, footer, wide, className = '', locked = false }) {
  // locked: no close button, Escape or backdrop click (used for must-confirm messages)
  const close = locked ? undefined : onClose;
  const ref = useRef(null);
  // Keep the latest close handler without re-running the effect: callers pass a new arrow function on
  // every render, and re-running it would steal focus back to the first field after each keystroke.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the first field once, when the window opens (not when the user is already typing somewhere)
    const t = setTimeout(() => {
      if (ref.current && !ref.current.contains(document.activeElement)) {
        ref.current.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea')?.focus();
      }
    }, 30);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close?.(); }}>
      <div className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        {title && (
          <div className="modal-header">
            <h2>{title}</h2>
            {!locked && <IconButton icon={X} label="סגירה" onClick={onClose} small />}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmText = 'אישור', danger = true, loading }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>ביטול</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmText}</Button>
        </>
      )}
    >
      <div className={`confirm-icon ${danger ? 'tone-danger' : 'tone-primary'}`}><AlertTriangle size={24} /></div>
      <h2 style={{ marginBottom: 6 }}>{title}</h2>
      <p className="muted">{message}</p>
    </Modal>
  );
}

/** Hook for confirm dialogs: const [confirm, dialog] = useConfirm(); await confirm({...}) */
export function useConfirm() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const confirm = (opts) => setState(opts);
  const dialog = (
    <ConfirmDialog
      open={!!state}
      {...(state || {})}
      loading={loading}
      onClose={() => !loading && setState(null)}
      onConfirm={async () => {
        setLoading(true);
        try { await state.onConfirm(); setState(null); } catch { /* the action reports its own error */ } finally { setLoading(false); }
      }}
    />
  );
  return [confirm, dialog];
}

// ---------- Form fields ----------
export function Field({ label, error, hint, children, className = '', htmlFor }) {
  return (
    <div className={`field ${className}`}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Input({ invalid, className = '', ...rest }) {
  return <input className={`input ${invalid ? 'invalid' : ''} ${className}`} {...rest} />;
}
export function Select({ invalid, className = '', children, ...rest }) {
  return <select className={`select ${invalid ? 'invalid' : ''} ${className}`} {...rest}>{children}</select>;
}
export function Textarea({ invalid, className = '', ...rest }) {
  return <textarea className={`textarea ${invalid ? 'invalid' : ''} ${className}`} {...rest} />;
}

// ---------- Loading / empty / error ----------
export function Skeleton({ h = 16, w = '100%', r, style }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r, ...style }} />;
}

export function SkeletonRows({ rows = 5, h = 44 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 16 }}>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={h} />)}
    </div>
  );
}

export function SkeletonPage() {
  return (
    <div>
      <Skeleton h={32} w={220} style={{ marginBottom: 20 }} />
      <div className="kpis">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={110} r={14} />)}</div>
      <div className="grid grid-2"><Skeleton h={300} r={14} /><Skeleton h={300} r={14} /></div>
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, text, action }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon size={28} /></div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="empty">
      <div className="empty-icon tone-danger"><AlertTriangle size={28} /></div>
      <h3>לא הצלחנו לטעון את הנתונים</h3>
      <p>{error?.message || 'אירעה שגיאה. נסו שוב.'}</p>
      {onRetry && <Button icon={RefreshCw} onClick={() => onRetry()}>נסו שוב</Button>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? 'active' : ''} onClick={() => onChange(t.value)} type="button">
          {t.icon && <t.icon size={16} />}{t.label}{t.count != null && <Badge tone={value === t.value ? 'primary' : 'neutral'}>{t.count}</Badge>}
        </button>
      ))}
    </div>
  );
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <o.icon size={15} />}{o.label}
        </button>
      ))}
    </div>
  );
}

export function SortHeader({ label, field, sort, onSort }) {
  const active = sort.field === field;
  return (
    <th className="sortable" onClick={() => onSort(field)} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className="flex" style={{ gap: 4 }}>
        {label}
        {active && (sort.dir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
      </span>
    </th>
  );
}

/** Small form state helper with server-side field errors. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = (k) => (e) => {
    const v = e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setValues((s) => ({ ...s, [k]: v }));
    if (errors[k]) setErrors((s) => ({ ...s, [k]: undefined }));
  };
  return { values, setValues, errors, setErrors, set };
}

/** Small holiday label for calendar day headers. */
export function HolidayTags({ list, compact }) {
  if (!list?.length) return null;
  return (
    <span className={`holiday-tags ${compact ? 'compact' : ''}`}>
      {list.map((h) => <span key={h.name} className={`holiday-tag kind-${h.kind}`} title={h.name}>{h.name}</span>)}
    </span>
  );
}
