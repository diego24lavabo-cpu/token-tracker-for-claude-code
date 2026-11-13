import { NavLink } from 'react-router-dom';
import { en } from '../i18n/en';
import { SECTIONS, type Section } from '../routes';
import { useAppData } from '../state/appData';
import { Logo } from './Logo';

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo />
        {en.app.shortName}
      </div>

      <nav className="sidebar-nav" aria-label={en.nav.label}>
        {SECTIONS.map((section) => (
          <NavItem key={section.id} id={section.id} path={section.path} />
        ))}
      </nav>

      <SourceBox />
    </aside>
  );
}

function NavItem({ id, path }: Section) {
  return (
    <>
      {id === 'settings' && <div className="sidebar-nav-separator" aria-hidden="true" />}
      <NavLink to={path} end={path === '/'} className="nav-item" draggable={false}>
        {en.nav[id]}
      </NavLink>
    </>
  );
}

/** Shows where the usage data comes from. */
function SourceBox() {
  const { info } = useAppData();
  if (!info) return <div className="sidebar-source" aria-hidden="true" />;

  // The sample data of demo mode sits in a temporary folder: its path says nothing.
  const roots = info.demo ? [] : info.logRoots.length > 0 ? info.logRoots : [info.defaultLogRoot];
  const note = info.demo
    ? en.source.sampleData
    : info.logRoots.length === 0
      ? en.source.notFound
      : null;

  return (
    <div className="sidebar-source">
      {en.source.label}
      {roots.map((root) => (
        <span key={root} className="sidebar-source-path" title={root}>
          {root}
        </span>
      ))}
      {note && <span className="sidebar-source-note">{note}</span>}
    </div>
  );
}
