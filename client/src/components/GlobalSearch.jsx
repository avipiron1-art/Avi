import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Search, User, CalendarDays, ListTodo, Inbox, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useDebounced } from '../lib/hooks.js';
import { Avatar, IconButton } from './ui.jsx';
import { REQUEST_TYPE } from '../lib/format.js';

const GROUPS = { employee: ['עובדים', User], shift: ['משמרות', CalendarDays], task: ['משימות', ListTodo], request: ['בקשות', Inbox] };

export default function GlobalSearch({ open, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(q, 200);
  const navigate = useNavigate();

  useEffect(() => { if (!open) { setQ(''); setResults([]); } }, [open]);
  useEffect(() => {
    if (dq.trim().length < 2) { setResults([]); return; }
    let alive = true;
    setLoading(true);
    api.get('/search', { q: dq }).then((r) => { if (alive) { setResults(r.results); setActive(0); } }).catch(() => {}).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dq]);

  if (!open) return null;
  const go = (r) => { onClose(); navigate(r.link); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter' && results[active]) go(results[active]);
    if (e.key === 'Escape') onClose();
  };

  let lastType = null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search-modal" role="dialog" aria-label="חיפוש גלובלי">
        <div className="flex" style={{ padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
          <Search size={20} className="muted" />
          <input autoFocus className="search-input" placeholder="חיפוש עובדים, משמרות, משימות ובקשות..." value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="חיפוש" />
          <IconButton icon={X} label="סגירה" onClick={onClose} small />
        </div>
        <div style={{ overflowY: 'auto', maxHeight: '60vh', paddingBottom: 8 }}>
          {q.trim().length < 2 && <div className="empty"><p>הקלידו לפחות 2 תווים כדי לחפש</p></div>}
          {q.trim().length >= 2 && !loading && results.length === 0 && dq === q && (
            <div className="empty"><h3>לא נמצאו תוצאות</h3><p>נסו מילת חיפוש אחרת, למשל שם עובד או כותרת משימה</p></div>
          )}
          {results.map((r, i) => {
            const header = r.type !== lastType ? GROUPS[r.type] : null;
            lastType = r.type;
            const Icon = GROUPS[r.type][1];
            return (
              <div key={`${r.type}-${r.id}`}>
                {header && <div className="search-group">{header[0]}</div>}
                <a href={r.link} className={`search-result ${i === active ? 'active' : ''}`} onClick={(e) => { e.preventDefault(); go(r); }} onMouseEnter={() => setActive(i)}>
                  {r.type === 'employee' ? <Avatar name={r.title} src={r.avatar} size={32} /> : <span className="activity-icon tone-primary"><Icon size={16} /></span>}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{r.title}</div>
                    <div className="subtle">{r.type === 'request' ? REQUEST_TYPE[r.subtitle] : r.subtitle}</div>
                  </div>
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
