'use client';

import { useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import type { AuthUser } from 'aws-amplify/auth';

import { AppHeader } from '@/components/app-header';
import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatThread } from '@/components/chat/chat-thread';
import { useChat } from '@/hooks/use-chat';
import type { RuntimeConfig } from '@/lib/chat';

export default function Page() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

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
    <Authenticator>
      {({ signOut, user }) => (
        <ChatApp config={config} user={user} signOut={signOut} />
      )}
    </Authenticator>
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
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-4 p-4">
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
