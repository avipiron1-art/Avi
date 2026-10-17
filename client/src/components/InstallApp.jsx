import { useState } from 'react';
import { Download, Share, PlusSquare, X, Smartphone } from 'lucide-react';
import { useInstall } from '../lib/install.js';
import { Button, IconButton, Modal } from './ui.jsx';

const DISMISS_KEY = 'install-banner-dismissed';
const readDismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } };

/** Step-by-step instructions for iPhone / iPad (Safari has no install prompt). */
export function IOSInstructions({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="התקנה באייפון / אייפד" footer={<Button variant="primary" onClick={onClose}>הבנתי</Button>}>
      <ol className="install-steps">
        <li><span className="install-step-num">1</span><span>פותחים את המערכת בדפדפן <strong>Safari</strong>.</span></li>
        <li><span className="install-step-num">2</span><span>לוחצים על כפתור השיתוף <Share size={16} className="inline-icon" /> בתחתית המסך.</span></li>
        <li><span className="install-step-num">3</span><span>גוללים ובוחרים <strong>הוספה למסך הבית</strong> <PlusSquare size={16} className="inline-icon" />.</span></li>
        <li><span className="install-step-num">4</span><span>לוחצים <strong>הוספה</strong>. האייקון של Shiftly יופיע במסך הבית.</span></li>
      </ol>
    </Modal>
  );
}

/** Button that installs the app (or explains how on iOS). Renders nothing once installed. */
export function InstallButton({ variant = 'default', block, label = 'התקנת האפליקציה' }) {
  const install = useInstall();
  const [ios, setIos] = useState(false);
  if (install.installed || (!install.canPrompt && !install.ios)) return null;
  return (
    <>
      <Button variant={variant} block={block} icon={Download} onClick={() => (install.canPrompt ? install.prompt() : setIos(true))}>{label}</Button>
      <IOSInstructions open={ios} onClose={() => setIos(false)} />
    </>
  );
}

/** Dismissible banner shown at the top of the app until installed. */
export function InstallBanner() {
  const install = useInstall();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [ios, setIos] = useState(false);
  if (dismissed || install.installed || (!install.canPrompt && !install.ios)) return null;
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage unavailable */ } };
  return (
    <div className="install-banner" role="region" aria-label="התקנת האפליקציה">
      <span className="install-banner-icon"><Smartphone size={20} /></span>
      <div className="install-banner-text">
        <strong>התקינו את Shiftly</strong>
        <span>גישה מהירה ממסך הבית, במסך מלא, כמו כל אפליקציה.</span>
      </div>
      <div className="install-banner-actions">
        <Button size="sm" variant="primary" icon={Download} onClick={() => (install.canPrompt ? install.prompt() : setIos(true))}>התקנה</Button>
        <IconButton icon={X} label="לא עכשיו" small onClick={dismiss} />
      </div>
      <IOSInstructions open={ios} onClose={() => setIos(false)} />
    </div>
  );
}
