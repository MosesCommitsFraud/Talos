import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { IncognitoToggle } from './components/IncognitoToggle';
import { Messages } from './components/Messages';
import { Welcome } from './components/Welcome';
import { Composer } from './components/Composer';
import { CommandPalette } from './components/CommandPalette';
import { SettingsDialog, type Panel, type SettingsScope } from './components/SettingsDialog';
import { ArchiveDialog } from './components/ArchiveDialog';
import { HelpDialog } from './components/HelpDialog';
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
  // null = closed. When set, the settings dialog opens to the given panel/scope.
  const [settings, setSettings] = useState<{ panel?: Panel; scope?: SettingsScope } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
              account={{
                onOpenSettings: () => setSettings({ scope: 'user' }),
                onOpenAdmin: () => setSettings({ scope: 'admin' }),
                onOpenHelp: () => setHelpOpen(true),
                onOpenArchive: () => setArchiveOpen(true),
                onOpenAccount: () => setSettings({ scope: 'user', panel: 'account' }),
              }}
            />
            <main className="relative flex min-w-0 flex-1 flex-col">
              {/* Fade the scrolling chat out before it reaches the floating
                  top-right controls, so messages don't glitch behind them. */}
              <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-24 bg-gradient-to-b from-background to-transparent" />
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
          <CommandPalette open={palette} onClose={() => setPalette(false)} onOpenSettings={() => setSettings({})} />
          <SettingsDialog
            open={!!settings}
            onClose={() => setSettings(null)}
            initialPanel={settings?.panel}
            scope={settings?.scope}
          />
          <ArchiveDialog open={archiveOpen} onClose={() => setArchiveOpen(false)} />
          <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
