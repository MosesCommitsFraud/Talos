import { QueryClientProvider } from '@tanstack/react-query';
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
import { RightPanel } from './components/RightPanel';
import { RagWorkspace } from './components/rag/RagWorkspace';
import { Lightbox } from './components/Lightbox';
import { PlanPanel } from './components/PlanPanel';
import { PendingQuestion } from './components/AskUser';
import { AuthGate } from './components/auth/AuthGate';
import { TooltipProvider } from './components/ui/misc';
import { applyDensity, applyLang, applyTheme, usePrefs } from './state/prefs';
import { selectPendingPlan, useChat } from './state/chat';
import { useUi } from './state/ui';
import { queryClient } from './lib/queryClient';

export default function App() {
  const [palette, setPalette] = useState(false);
  // null = closed. When set, the settings dialog opens to the given panel/scope.
  const [settings, setSettings] = useState<{ panel?: Panel; scope?: SettingsScope } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const theme = usePrefs((s) => s.theme);
  const density = usePrefs((s) => s.density);
  const lang = usePrefs((s) => s.lang);
  // A cold-opened session is activated before its history request resolves.
  // Treat the session id—not the temporary message count—as the distinction
  // between a conversation and a genuinely new draft, avoiding a welcome-page
  // flash while older chat history loads.
  const hasActiveSession = useChat((s) => s.sessionId !== null);
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
                onOpenRag: () => setView('rag'),
              }}
            />
            {view === 'rag' ? (
              <RagWorkspace />
            ) : (
              <>
                <main className="relative flex min-w-0 flex-1 flex-col">
                  <IncognitoToggle />
                  {/* Empty chat shows the home screen (greeting + usage stats)
                      in the message area; the composer always sits at the
                      bottom of the viewport. */}
                  {hasActiveSession ? <Messages /> : <Welcome />}
                  <div className="shrink-0">
                    <PendingQuestion />
                    <Composer />
                  </div>
                </main>
                <PlanPanel />
                <RightPanel />
              </>
            )}
          </div>
          <CommandPalette
            open={palette}
            onClose={() => setPalette(false)}
            onOpenSettings={() => setSettings({})}
            onOpenRag={() => setView('rag')}
          />
          <SettingsDialog
            open={!!settings}
            onClose={() => setSettings(null)}
            initialPanel={settings?.panel}
            scope={settings?.scope}
            onOpenRag={() => setView('rag')}
          />
          <ArchiveDialog open={archiveOpen} onClose={() => setArchiveOpen(false)} />
          <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
          <Lightbox />
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
