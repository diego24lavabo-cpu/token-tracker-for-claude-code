import { Cpu } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { Page } from '../components/Page';
import { en } from '../i18n/en';

export function Models() {
  return (
    <Page section="models">
      <EmptyState
        icon={<Cpu size={22} strokeWidth={1.75} />}
        title={en.placeholder.title}
        body={en.placeholder.body}
      />
    </Page>
  );
}
