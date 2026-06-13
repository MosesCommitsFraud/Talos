import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { login, setupAdmin, signup } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/misc';

type Mode = 'login' | 'signup' | 'setup' | 'totp';

export function LoginScreen({
  initialMode,
  signupEnabled,
  onAuthenticated,
}: {
  initialMode: 'login' | 'setup';
  signupEnabled: boolean;
  onAuthenticated: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const copy = {
    heading: t(`login.${mode}Heading`),
    sub: t(`login.${mode}Sub`),
    cta: t(`login.${mode}Cta`),
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const name = username.trim();
    if (!name) { setError(t('login.usernameRequired')); return; }
    if (mode !== 'totp') {
      if ((mode === 'setup' || mode === 'signup') && password.length < 8) {
        setError(t('login.passwordTooShort'));
        return;
      }
      if ((mode === 'setup' || mode === 'signup') && password !== confirm) {
        setError(t('login.passwordMismatch'));
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === 'setup') await setupAdmin(name, password);
      else if (mode === 'signup') await signup(name, password);
      const result = await login(name, password, mode === 'totp' ? totpCode.trim() : undefined);
      if (result.requires_totp) {
        setMode('totp');
        setBusy(false);
        return;
      }
      if (result.ok) {
        onAuthenticated();
        return;
      }
      setError(t('login.signInFailed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.requestFailed'));
    }
    setBusy(false);
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-[340px]">
        <div className="mb-6 text-center">
          <svg viewBox="0 0 32 32" aria-hidden="true" className="mx-auto mb-3 size-11 text-primary">
            <path d="M16 4L16 22L6 22Z" fill="currentColor" />
            <path d="M16 8L16 22L24 22Z" fill="currentColor" opacity="0.6" />
            <path d="M4 24Q10 20 16 24Q22 28 28 24" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </svg>
          <h1 className="font-semibold text-foreground text-xl">{copy.heading}</h1>
          <p className="mt-1 text-muted-foreground text-sm">{copy.sub}</p>
        </div>

        <form onSubmit={submit} className="rounded-xl border bg-popover p-5 shadow-xs/5">
          <div className="flex flex-col gap-3">
            {mode === 'totp' ? (
              <Input
                autoFocus
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label={t('login.twoFactorCode')}
                className="text-center tracking-widest"
              />
            ) : (
              <>
                <label className="flex flex-col gap-1 text-muted-foreground text-xs">
                  {t('login.username')}
                  <Input
                    autoFocus
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-muted-foreground text-xs">
                  {t('login.password')}
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                </label>
                {(mode === 'setup' || mode === 'signup') && (
                  <label className="flex flex-col gap-1 text-muted-foreground text-xs">
                    {t('login.confirmPassword')}
                    <Input
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      autoComplete="new-password"
                    />
                  </label>
                )}
              </>
            )}

            {error && <p className="text-destructive-foreground text-xs">{error}</p>}

            <Button type="submit" disabled={busy} className="mt-1 w-full">
              {busy ? t('login.pleaseWait') : copy.cta}
            </Button>
          </div>
        </form>

        {mode === 'totp' && (
          <button
            type="button"
            className="mt-4 block w-full text-center text-muted-foreground text-xs hover:text-foreground"
            onClick={() => { setMode('login'); setTotpCode(''); setError(''); }}
          >
            {t('login.backToSignIn')}
          </button>
        )}
        {mode === 'login' && signupEnabled && (
          <button
            type="button"
            className="mt-4 block w-full text-center text-muted-foreground text-xs hover:text-foreground"
            onClick={() => { setMode('signup'); setError(''); }}
          >
            {t('login.noAccount')}
          </button>
        )}
        {mode === 'signup' && (
          <button
            type="button"
            className="mt-4 block w-full text-center text-muted-foreground text-xs hover:text-foreground"
            onClick={() => { setMode('login'); setError(''); }}
          >
            {t('login.haveAccount')}
          </button>
        )}
      </div>
    </div>
  );
}
