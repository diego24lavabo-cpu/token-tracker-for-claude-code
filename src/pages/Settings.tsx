import { Settings as SettingsIcon } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { Page } from '../components/Page';
import { en } from '../i18n/en';

export function Settings() {
  return (
    <Page section="settings">
      <EmptyState
        icon={<SettingsIcon size={22} strokeWidth={1.75} />}
        title={en.placeholder.title}
        body={en.placeholder.body}
      />
    </Page>
  );
}
