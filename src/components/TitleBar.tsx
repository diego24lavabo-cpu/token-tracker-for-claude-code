import { useNow } from '../hooks/useNow';
import { en } from '../i18n/en';
import { formatTimeAgo } from '../lib/format';
import { useAppData } from '../state/appData';

const t = en.titleBar;

/** Custom title bar. It is the window's drag region; the OS draws its buttons on top of it. */
export function TitleBar() {
  const { sync } = useAppData();
  const now = useNow();

  let text: string = t.localOnly;
  let tone = 'off';
  if (sync?.enabled) {
    if (sync.state === 'needsFolder') {
      text = t.needsFolder;
      tone = 'warning';
    } else if (sync.state === 'pending') {
      text = t.pending;
      tone = 'warning';
    } else {
      text = sync.lastSync ? t.synced(sync.machines, formatTimeAgo(sync.lastSync, now)) : t.notYet;
      tone = 'on';
    }
  } else if (sync && sync.machines > 1) {
    text = t.offWithMachines(sync.machines);
  }

  return (
    <header className="titlebar">
      <span className="titlebar-title">{en.app.name}</span>
      <span className={`titlebar-status titlebar-status--${tone}`} role="status">
        <span className="status-dot" aria-hidden="true" />
        {text}
      </span>
    </header>
  );
}
