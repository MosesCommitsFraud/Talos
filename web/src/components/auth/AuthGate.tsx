import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type * as React from 'react';
import { fetchAuthStatus, UNAUTHENTICATED_EVENT, type AuthStatus } from '@/api/client';
import { syncPrefsForUser } from '@/state/prefs';
import { LoginScreen } from './LoginScreen';

const AUTH_QUERY_KEY = ['auth', 'status'] as const;

/** Current auth status (username, is_admin, privileges). Only meaningful
 *  inside AuthGate, where the query is guaranteed to be populated. */
export function useAuth(): AuthStatus | undefined {
  const { data } = useQuery({ queryKey: AUTH_QUERY_KEY, queryFn: fetchAuthStatus, staleTime: 60_000 });
  return data;
}

/**
 * Gates the app behind authentication. Renders, in order of precedence:
 * a splash while the status loads, the first-launch setup screen when no
 * users exist, the login screen when unauthenticated, or the app itself.
 *
 * Sessions are server-side and in-memory: when the backend restarts, the
 * next API call 401s, the api client fires UNAUTHENTICATED_EVENT, and the
 * gate flips back to the login screen without a page navigation.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: fetchAuthStatus,
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: 'always',
  });

  useEffect(() => {
    const onUnauthenticated = () => {
      qc.setQueryData<AuthStatus>(AUTH_QUERY_KEY, (prev) => ({ ...(prev ?? {}), authenticated: false }));
      qc.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, [qc]);

  // Once we know who's signed in (or that auth is off), pull that user's
  // server-side UI prefs and start pushing local changes back.
  const signedInAs = data?.auth_enabled === false ? 'local' : data?.authenticated ? (data.username ?? 'local') : null;
  useEffect(() => {
    if (signedInAs) void syncPrefsForUser(signedInAs);
  }, [signedInAs]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  // AUTH_ENABLED=false deployments have no sessions at all — render the app.
  if (data?.auth_enabled === false) return <>{children}</>;

  if (isError || !data?.authenticated) {
    return (
      <LoginScreen
        initialMode={data?.configured === false ? 'setup' : 'login'}
        signupEnabled={!!data?.signup_enabled}
        onAuthenticated={() => {
          // Refetch everything: queries that 401ed pre-login are stale.
          qc.invalidateQueries();
        }}
      />
    );
  }

  return <>{children}</>;
}
