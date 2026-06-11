import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatHeader } from './components/ChatHeader';
import { Messages } from './components/Messages';
import { Composer } from './components/Composer';
import { CommandPalette } from './components/CommandPalette';
import { SettingsDialog } from './components/SettingsDialog';
import { BrainDialog, LibraryDialog } from './components/ToolDialogs';
import { TooltipProvider } from './components/ui/misc';
import { applyTheme, usePrefs } from './state/prefs';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

export default function App() {
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [brain, setBrain] = useState(false);
  const [library, setLibrary] = useState(false);
  const theme = usePrefs((s) => s.theme);

  useEffect(() => applyTheme(theme), [theme]);

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
        <div className="flex h-full">
          <Sidebar
            onOpenPalette={() => setPalette(true)}
            onOpenSettings={() => setSettings(true)}
            onOpenBrain={() => setBrain(true)}
            onOpenLibrary={() => setLibrary(true)}
          />
          <main className="flex min-w-0 flex-1 flex-col">
            <ChatHeader />
            <Messages />
            <Composer />
          </main>
        </div>
        <CommandPalette open={palette} onClose={() => setPalette(false)} />
        <SettingsDialog open={settings} onClose={() => setSettings(false)} />
        <BrainDialog open={brain} onClose={() => setBrain(false)} />
        <LibraryDialog open={library} onClose={() => setLibrary(false)} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
