import { useEffect, useState } from 'react';
import { Save, CalendarClock } from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Button, Card, ErrorState, Input, PageHeader, SkeletonRows } from '../components/ui.jsx';

export default function Availability() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi('/requests/availability/me');
  const [days, setDays] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setDays(data.availability); }, [data]);

  const upd = (i, patch) => setDays((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/requests/availability/me', { days: days.map(({ weekday, available, from_time, to_time, note }) => ({ weekday, available, from_time, to_time, note })) });
      setDays(r.availability);
      toast.success(r.message);
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader title="הזמינות שלי" subtitle="דווחו באילו ימים ושעות אתם זמינים לעבודה. המנהל יראה זאת בעת בניית הסידור."
        actions={<Button variant="primary" icon={Save} onClick={save} loading={saving} disabled={!days}>שמירת זמינות</Button>} />
      <Card title="זמינות שבועית" icon={CalendarClock} pad={false}>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading || !days ? <SkeletonRows rows={7} /> : (
          <div className="list">
            {days.map((d, i) => (
              <div key={d.weekday} className="list-item flex-wrap">
                <strong style={{ width: 70 }}>{d.name}</strong>
                <label className="checkbox" style={{ width: 110 }}>
                  <input type="checkbox" checked={d.available} onChange={(e) => upd(i, { available: e.target.checked })} />
                  {d.available ? 'זמין/ה' : 'לא זמין/ה'}
                </label>
                {d.available && (
                  <div className="flex">
                    <Input type="time" value={d.from_time || ''} onChange={(e) => upd(i, { from_time: e.target.value })} style={{ width: 120 }} aria-label={`משעה ביום ${d.name}`} />
                    <span className="muted">עד</span>
                    <Input type="time" value={d.to_time || ''} onChange={(e) => upd(i, { to_time: e.target.value })} style={{ width: 120 }} aria-label={`עד שעה ביום ${d.name}`} />
                  </div>
                )}
                <Input placeholder="הערה (אופציונלי)" value={d.note || ''} onChange={(e) => upd(i, { note: e.target.value })} style={{ flex: 1, minWidth: 160 }} maxLength={200} aria-label={`הערה ליום ${d.name}`} />
              </div>
            ))}
          </div>
        )}
      </Card>
      <p className="subtle mt">השאירו את השעות ריקות אם אתם זמינים כל היום.</p>
    </>
  );
}
