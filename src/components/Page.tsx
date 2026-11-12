import type { ReactNode } from 'react';
import { en } from '../i18n/en';
import type { SectionId } from '../routes';
import { Header } from './Header';

interface PageProps {
  section: SectionId;
  /** Set on a page that ignores the period, to say why the period selector is off. */
  periodIgnored?: string;
  /** Set on a page that ignores the machine filter, to say why its selector is off. */
  machinesIgnored?: string;
  children: ReactNode;
}

/** Page frame: the shared header for the given section, then the page content. */
export function Page({ section, periodIgnored, machinesIgnored, children }: PageProps) {
  const { title, subtitle } = en.pages[section];
  return (
    <div className="page">
      <Header
        title={title}
        subtitle={subtitle}
        periodIgnored={periodIgnored}
        machinesIgnored={machinesIgnored}
      />
      {children}
    </div>
  );
}
