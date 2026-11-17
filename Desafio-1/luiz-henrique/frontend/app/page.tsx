'use client';

import { useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import {
  Authenticator,
  defaultDarkModeOverride,
  ThemeProvider as AmplifyThemeProvider,
} from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import type { AuthUser } from 'aws-amplify/auth';
import { useTheme } from 'next-themes';

import { AppHeader } from '@/components/app-header';
import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatThread } from '@/components/chat/chat-thread';
import { useChat } from '@/hooks/use-chat';
import type { RuntimeConfig } from '@/lib/chat';

const amplifyTheme = {
  name: 'desafio1',
  overrides: [defaultDarkModeOverride],
};

export default function Page() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    fetch('/config.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`config ${r.status}`))))
      .then((cfg: RuntimeConfig) => {
        Amplify.configure({
          Auth: {
            Cognito: {
              userPoolId: cfg.userPoolId,
              userPoolClientId: cfg.userPoolClientId,
            },
          },
        });
        setConfig(cfg);
      })
      .catch((err) => setConfigError(`Não foi possível carregar config.json: ${err.message}`));
  }, []);

  if (configError) {
    return <div className="p-8 text-sm text-destructive">{configError}</div>;
  }

  if (!config) {
    return <div className="p-8 text-sm text-muted-foreground">Carregando...</div>;
  }

  return (
    <AmplifyThemeProvider
      colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
      theme={amplifyTheme}
    >
      <Authenticator hideSignUp>
        {({ signOut, user }) => (
          <ChatApp config={config} user={user} signOut={signOut} />
        )}
      </Authenticator>
    </AmplifyThemeProvider>
  );
}

function ChatApp({
  config,
  user,
  signOut,
}: {
  config: RuntimeConfig;
  user?: AuthUser;
  signOut?: () => void;
}) {
  const { token, messages, loading, send, reset } = useChat(config);

  function handleSignOut() {
    reset();
    signOut?.();
  }

  return (
    <main className="mx-auto flex h-dvh max-w-2xl flex-col gap-4 px-4 pt-4 pb-[max(5dvh,env(safe-area-inset-bottom))]">
      {user && <AppHeader user={user} onSignOut={handleSignOut} />}
      <ChatThread messages={messages} loading={loading} />
      <ChatComposer
        messages={messages}
        loading={loading}
        disabled={!token}
        onSend={send}
      />
    </main>
  );
}
