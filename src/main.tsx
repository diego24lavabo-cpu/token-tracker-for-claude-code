import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './theme.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { LanguageInfo } from '../shared/language';
import { App } from './App';
import { applyLanguage } from './state/language';
import { LanguageProvider } from './state/LanguageProvider';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

/** The language comes first, so the first frame is already in it. */
async function start(element: HTMLElement): Promise<void> {
  let language: LanguageInfo = { setting: 'system', language: 'en', system: 'en' };
  try {
    language = await window.api.getLanguage();
  } catch (error) {
    console.error('Could not read the language, using English', error);
  }
  applyLanguage(language);

  createRoot(element).render(
    <StrictMode>
      <LanguageProvider initial={language}>
        <App />
      </LanguageProvider>
    </StrictMode>,
  );
}

void start(root);
