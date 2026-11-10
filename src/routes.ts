export type SectionId =
  'overview' | 'projects' | 'models' | 'calendar' | 'sessions' | 'agents' | 'machines' | 'settings';

export interface Section {
  id: SectionId;
  path: string;
}

/** The sidebar sections, in display order. Settings sits apart at the bottom of the list. */
export const SECTIONS: readonly Section[] = [
  { id: 'overview', path: '/' },
  { id: 'projects', path: '/projects' },
  { id: 'models', path: '/models' },
  { id: 'calendar', path: '/calendar' },
  { id: 'sessions', path: '/sessions' },
  { id: 'agents', path: '/agents' },
  { id: 'machines', path: '/machines' },
  { id: 'settings', path: '/settings' },
];
