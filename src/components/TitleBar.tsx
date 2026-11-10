import { en } from '../i18n/en';

/** Custom title bar. It is the window's drag region; the OS draws its buttons on top of it. */
export function TitleBar() {
  return (
    <header className="titlebar">
      <span className="titlebar-title">{en.app.name}</span>
      <span className="titlebar-status">
        <span className="status-dot" aria-hidden="true" />
        {en.titleBar.localOnly}
      </span>
    </header>
  );
}
