import type { ReactNode } from 'react';
import { en } from '../i18n/en';
import type { SectionId } from '../routes';
import { Header } from './Header';

/** Page frame: the shared header for the given section, then the page content. */
export function Page({ section, children }: { section: SectionId; children: ReactNode }) {
  const { title, subtitle } = en.pages[section];
  return (
    <div className="page">
      <Header title={title} subtitle={subtitle} />
      {children}
    </div>
  );
}
