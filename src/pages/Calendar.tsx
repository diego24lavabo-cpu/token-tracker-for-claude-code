import { CalendarDays } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { Page } from '../components/Page';
import { en } from '../i18n/en';

export function Calendar() {
  return (
    <Page section="calendar">
      <EmptyState
        icon={<CalendarDays size={22} strokeWidth={1.75} />}
        title={en.placeholder.title}
        body={en.placeholder.body}
      />
    </Page>
  );
}
