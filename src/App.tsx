import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { Agents } from './pages/Agents';
import { Calendar } from './pages/Calendar';
import { Machines } from './pages/Machines';
import { Models } from './pages/Models';
import { Overview } from './pages/Overview';
import { Projects } from './pages/Projects';
import { Sessions } from './pages/Sessions';
import { Settings } from './pages/Settings';
import { SECTIONS } from './routes';
import { AppDataProvider } from './state/AppDataProvider';
import { FiltersProvider } from './state/FiltersProvider';

export function App() {
  return (
    <HashRouter>
      <AppDataProvider>
        <FiltersProvider>
          <Shell />
        </FiltersProvider>
      </AppDataProvider>
    </HashRouter>
  );
}

function Shell() {
  useSectionShortcuts();

  return (
    <div className="app" data-platform={window.api.platform}>
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <main className="main">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/models" element={<Models />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/machines" element={<Machines />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/** Cmd+1…8 on macOS and Ctrl+1…8 elsewhere jump to the sections in sidebar order. */
function useSectionShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    const isMac = window.api.platform === 'darwin';

    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || event.altKey || event.shiftKey) return;
      // `code` is the physical key, so the shortcut also works on layouts such as AZERTY
      // where the digit row needs Shift.
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1];
      const section = digit ? SECTIONS[Number(digit) - 1] : undefined;
      if (!section) return;
      event.preventDefault();
      void navigate(section.path);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);
}
