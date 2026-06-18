import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { IncognitoToggle } from './components/IncognitoToggle';
import { Messages } from './components/Messages';
import { Welcome } from './components/Welcome';
import { Composer } from './components/Composer';
import { CommandPalette } from './components/CommandPalette';
import { SettingsDialog } from './components/SettingsDialog';
import { BrainDialog, LibraryDialog } from './components/ToolDialogs';
import { ArtifactsPanel } from './components/ArtifactsPanel';
import { PlanPanel } from './components/PlanPanel';
import { PendingQuestion } from './components/AskUser';
import { AuthGate } from './components/auth/AuthGate';
import { TooltipProvider } from './components/ui/misc';
import { applyDensity, applyLang, applyTheme, usePrefs } from './state/prefs';
import { selectPendingPlan, useChat } from './state/chat';
import { useUi } from './state/ui';
import { cn } from './lib/utils';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

export default function App() {
  const [palette, setPalette] = useState(false);
  const [settings, setSettings] = useState(false);
  const [brain, setBrain] = useState(false);
  const [library, setLibrary] = useState(false);
  const filesOpen = useUi((s) => s.artifactsOpen);
  const setFilesOpen = useUi((s) => s.setArtifactsOpen);
  const theme = usePrefs((s) => s.theme);
  const density = usePrefs((s) => s.density);
  const lang = usePrefs((s) => s.lang);
  const hasMessages = useChat((s) => s.messages.length > 0);
  const pendingPlanId = useChat((s) => selectPendingPlan(s)?.id ?? null);
  const setPlanPanelOpen = useUi((s) => s.setPlanPanelOpen);

  // A freshly proposed plan slides the panel open (like opening an artifact).
  useEffect(() => {
    if (pendingPlanId) setPlanPanelOpen(true);
  }, [pendingPlanId, setPlanPanelOpen]);

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
            <main className="relative flex min-w-0 flex-1 flex-col">
              <IncognitoToggle />
              <Messages />
              {/* On an empty chat the composer (with the greeting above it) is
                  lifted to the vertical center; sending the first message drops
                  `hasMessages` → the transform releases and it slides to the
                  bottom. transform-only, so no layout reflow during the slide. */}
              <div
                className={cn(
                  'shrink-0 transition-transform duration-500 ease-out',
                  !hasMessages && '-translate-y-[calc(50dvh-50%)]',
                )}
              >
                {!hasMessages && <Welcome />}
                <PendingQuestion />
                <Composer />
              </div>
            </main>
            <ArtifactsPanel open={filesOpen} onClose={() => setFilesOpen(false)} />
            <PlanPanel />
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
