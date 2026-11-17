import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import '@aws-amplify/ui-react/styles.css';
import App from './App.jsx';
import { configureApi } from './api.js';
import './index.css';

async function start() {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Não foi possível carregar a configuração publicada pela infraestrutura.');
  }
  const config = await response.json();
  if (!config.userPoolId || !config.userPoolClientId || !config.apiUrl) {
    throw new Error('A configuração da aplicação está incompleta.');
  }
  configureApi(config.apiUrl);

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  });

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

start().catch((error) => {
  document.getElementById('root').textContent = error.message;
});
