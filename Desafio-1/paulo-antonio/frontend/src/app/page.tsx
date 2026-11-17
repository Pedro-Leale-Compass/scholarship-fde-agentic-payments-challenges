'use client';

import { useEffect, useState } from 'react';
import { Amplify } from 'aws-amplify';
import { fetchAuthSession, signOut } from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { sessionStorage, I18n } from 'aws-amplify/utils';
import { Authenticator, translations } from '@aws-amplify/ui-react';
import { PaymentsPanel } from './payments-panel';
import { ChatPanel } from './chat-panel';

interface AppConfig { apiUrl: string; userPoolId: string; userPoolClientId: string; region: string }
type CheckState = 'loading' | 'success' | 'error';

function parseConfig(value: unknown): AppConfig {
  if (!value || typeof value !== 'object') throw new Error('Configuração indisponível.');
  const config = value as Record<string, unknown>;
  for (const key of ['apiUrl', 'userPoolId', 'userPoolClientId', 'region']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error('Configuração incompleta.');
  }
  const apiUrl = new URL(config.apiUrl as string);
  if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error('Endereço da aplicação inválido.');
  }
  if (config.region !== 'us-east-1' || !(config.userPoolId as string).startsWith('us-east-1_')) {
    throw new Error('Região da aplicação inválida.');
  }
  return { ...config, apiUrl: apiUrl.href.replace(/\/?$/, '/') } as unknown as AppConfig;
}

function SessionPanel({ config }: { config: AppConfig }) {
  const [state, setState] = useState<CheckState>('loading');
  const [attempt, setAttempt] = useState(0);
  const [logoutError, setLogoutError] = useState('');
  const [paymentVersion, setPaymentVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    async function validate() {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken;
        if (!token) throw new Error('Sem sessão');
        const response = await fetch(new URL('sessao', config.apiUrl), {
          headers: { Authorization: `Bearer ${token.toString()}` },
          cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Falha de autorização');
        const result = await response.json();
        if (result.autenticado !== true || result.usuario_id !== token.payload.sub) {
          throw new Error('Sessão incompatível');
        }
        if (!controller.signal.aborted) setState('success');
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    }
    void validate();
    return () => controller.abort();
  }, [config.apiUrl, attempt]);

  async function logout() {
    setLogoutError('');
    try { await signOut(); } catch { setLogoutError('Não foi possível sair. Tente novamente.'); }
  }

  return <section className="session-panel">
    <div className="panel-heading"><h2>Seu acesso</h2><button className="secondary" onClick={logout}>Sair</button></div>
    <div role="status" aria-live="polite">
      {state === 'loading' && <p>Confirmando seu acesso…</p>}
      {state === 'success' && <><span className="badge">Acesso confirmado</span><p>Você pode conversar com o assistente ou usar o formulário de compras.</p></>}
      {state === 'error' && <><p className="error">Não foi possível confirmar seu acesso. Tente novamente ou saia e entre na sua conta.</p><button onClick={() => setAttempt(n => n + 1)}>Tentar novamente</button></>}
    </div>
    {logoutError && <p role="alert" className="error">{logoutError}</p>}
    {state === 'success' && <><ChatPanel apiUrl={config.apiUrl} onPayment={() => setPaymentVersion(n => n + 1)} /><PaymentsPanel key={paymentVersion} apiUrl={config.apiUrl} /></>}
  </section>;
}

export default function Home() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/config.json', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Configuração indisponível.');
        const settings = parseConfig(await response.json());
        I18n.putVocabularies(translations);
        I18n.putVocabulariesForLanguage('pt', {
          'Email': 'E-mail', 'Password is hidden': 'Senha oculta', 'Password is shown': 'Senha visível',
        });
        I18n.setLanguage('pt');
        Amplify.configure({ Auth: { Cognito: {
          userPoolId: settings.userPoolId, userPoolClientId: settings.userPoolClientId,
          loginWith: { email: true },
        } } });
        cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage);
        if (!controller.signal.aborted) setConfig(settings);
      } catch {
        if (!controller.signal.aborted) setError('Não foi possível carregar a configuração. Recarregue a página ou avise o responsável pelo ambiente.');
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  return <main>
    <header><span className="eyebrow">AMBIENTE DE DEMONSTRAÇÃO</span><h1>Agente de pagamentos</h1><p>Um espaço para consultar produtos e simular compras com segurança.</p></header>
    {!config && !error && <p role="status">Preparando seu acesso…</p>}
    {error && <section className="session-panel"><p role="alert" className="error">{error}</p><button onClick={() => window.location.reload()}>Recarregar</button></section>}
    {config && <Authenticator hideSignUp loginMechanisms={['email']} formFields={{
      signIn: { username: { label: 'E-mail', placeholder: 'Digite seu e-mail' } },
    }}><SessionPanel config={config} /></Authenticator>}
    <footer>Acesso exclusivo para participantes convidados. Todos os pagamentos deste projeto são simulados.</footer>
  </main>;
}
