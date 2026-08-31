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
import { UsersWorkspace } from './components/users/UsersWorkspace';
import { TicketsWorkspace } from './components/tickets/TicketsWorkspace';
import { TicketDialog } from './components/tickets/TicketDialog';
import { Lightbox } from './components/Lightbox';
import { PlanPanel } from './components/PlanPanel';
import { TasksPanel } from './components/TasksPanel';
import { PendingQuestion } from './components/AskUser';
import { AuthGate } from './components/auth/AuthGate';
import { TooltipProvider } from './components/ui/misc';
import { Toaster } from './components/ui/toast';
import { applyDensity, applyLang, applyTheme, usePrefs } from './state/prefs';
import { selectPendingPlan, useChat } from './state/chat';
import { useUi } from './state/ui';
import { queryClient } from './lib/queryClient';

/** Runs once, after auth resolves: reopens the chat that was on screen before
 *  the reload, then reattaches to every turn still running server-side. Without
 *  it a refresh mid-turn looks like the query died — the run keeps going on the
 *  server, but nothing in the UI is listening to it. */
function SessionRestore() {
  const restoreLastSession = useChat((s) => s.restoreLastSession);
  const hydrateActiveRuns = useChat((s) => s.hydrateActiveRuns);
  useEffect(() => {
    void (async () => {
      await restoreLastSession();
      await hydrateActiveRuns();
    })();
    // Keep checking: a stream that drops for any other reason (sleep, network
    // blip, a proxy timing the connection out) reattaches on the next tick and
    // replays what it missed, instead of leaving the chat frozen mid-answer.
    const tick = () => void hydrateActiveRuns();
    const timer = window.setInterval(tick, 15_000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', tick);
    };
  }, [restoreLastSession, hydrateActiveRuns]);
  return null;
}

export default function App() {
  const [palette, setPalette] = useState(false);
  // null = closed. When set, the settings dialog opens to the given panel/scope.
  const [settings, setSettings] = useState<{ panel?: Panel; scope?: SettingsScope } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
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
          <SessionRestore />
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
                onOpenTickets: () => setView('tickets'),
              }}
              onOpenTicketDialog={() => setTicketOpen(true)}
            />
            {view === 'rag' ? (
              <RagWorkspace />
            ) : view === 'users' ? (
              <UsersWorkspace />
            ) : view === 'tickets' ? (
              <TicketsWorkspace />
            ) : (
              <>
                <main className="relative flex min-w-0 flex-1 flex-col">
                  {/* Empty chat shows the home screen (greeting + usage stats)
                      in the message area; the composer always sits at the
                      bottom of the viewport. */}
                  {hasActiveSession ? <Messages /> : <Welcome />}
                  {/* After the message area on purpose: the header's fade is
                      unlayered (no z-index) so it paints over the messages but
                      still under the body film grain — with a z-index it would
                      sit above the grain and read as a different colour than
                      the chat background it is meant to match. */}
                  <IncognitoToggle />
                  <div className="relative shrink-0">
                    {/* Mirror of the header fade, shorter: messages dissolve
                        into the background instead of running into the
                        composer. Unlayered for the same reason (see below). */}
                    <div
                      className="pointer-events-none absolute inset-x-0 bottom-full h-6"
                      style={{
                        background:
                          'linear-gradient(to top, var(--background) 35%, rgb(from var(--background) r g b / 0) 100%)',
                      }}
                    />
                    <PendingQuestion />
                    <Composer />
                  </div>
                </main>
                <PlanPanel />
                <TasksPanel />
                <RightPanel />
              </>
            )}
          </div>
          <CommandPalette
            open={palette}
            onClose={() => setPalette(false)}
            onOpenSettings={() => setSettings({})}
            onOpenRag={() => setView('rag')}
            onOpenUsers={() => setView('users')}
            onOpenTickets={() => setView('tickets')}
          />
          <SettingsDialog
            open={!!settings}
            onClose={() => setSettings(null)}
            initialPanel={settings?.panel}
            scope={settings?.scope}
            onOpenRag={() => setView('rag')}
            onOpenUsers={() => setView('users')}
          />
          <ArchiveDialog open={archiveOpen} onClose={() => setArchiveOpen(false)} />
          <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
          <TicketDialog open={ticketOpen} onClose={() => setTicketOpen(false)} />
          <Lightbox />
          <Toaster />
        </AuthGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
