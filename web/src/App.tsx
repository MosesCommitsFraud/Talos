import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatHeader } from './components/ChatHeader';
import { Messages } from './components/Messages';
import { Composer } from './components/Composer';
import { CommandPalette } from './components/CommandPalette';
import { SettingsDialog } from './components/SettingsDialog';
import { BrainDialog, LibraryDialog } from './components/ToolDialogs';
import { ArtifactsPanel } from './components/ArtifactsPanel';
import { AuthGate } from './components/auth/AuthGate';
import { TooltipProvider } from './components/ui/misc';
import { applyDensity, applyLang, applyTheme, usePrefs } from './state/prefs';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

export default function App() {
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [brain, setBrain] = useState(false);
  const [library, setLibrary] = useState(false);
  const [files, setFiles] = useState(false);
  const theme = usePrefs((s) => s.theme);
  const density = usePrefs((s) => s.density);
  const lang = usePrefs((s) => s.lang);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => applyDensity(density), [density]);
  useEffect(() => applyLang(lang), [lang]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthGate>
          <div className="flex h-full">
            <Sidebar
              onOpenPalette={() => setPalette(true)}
              onOpenSettings={() => setSettings(true)}
              onOpenBrain={() => setBrain(true)}
              onOpenLibrary={() => setLibrary(true)}
            />
            <main className="flex min-w-0 flex-1 flex-col">
              <ChatHeader onToggleFiles={() => setFiles((v) => !v)} filesOpen={files} />
              <Messages />
              <Composer />
            </main>
            <ArtifactsPanel open={files} onClose={() => setFiles(false)} />
          </div>
          <CommandPalette open={palette} onClose={() => setPalette(false)} onOpenSettings={() => setSettings(true)} />
          <SettingsDialog open={settings} onClose={() => setSettings(false)} />
          <BrainDialog open={brain} onClose={() => setBrain(false)} />
          <LibraryDialog open={library} onClose={() => setLibrary(false)} />
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
