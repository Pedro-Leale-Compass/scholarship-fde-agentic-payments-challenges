import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { I18n } from 'aws-amplify/utils';
import { translations } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';

import App from './App';
import { carregarConfig } from './config';
import type { AppConfig } from './config';
import './index.css';

// Configura internacionalização do Authenticator para português
I18n.putVocabularies(translations);
I18n.setLanguage('pt-br');

const root = ReactDOM.createRoot(document.getElementById('root')!);

carregarConfig()
  .then((config: AppConfig) => {
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.userPoolClientId,
          loginWith: {
            email: true,
          },
        },
      },
    });

    root.render(
      <React.StrictMode>
        <App config={config} />
      </React.StrictMode>
    );
  })
  .catch((err) => {
    root.render(
      <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif' }}>
        <h2>Erro de Configuração</h2>
        <p>Não foi possível carregar as configurações do sistema.</p>
        <p style={{ color: '#666', fontSize: '0.875rem' }}>{String(err)}</p>
      </div>
    );
  });
