import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { Authenticator, translations } from '@aws-amplify/ui-react';
import { I18n } from 'aws-amplify/utils';
import '@aws-amplify/ui-react/styles.css';
import './index.css';
import App from './App.jsx';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
    },
  },
});
I18n.putVocabularies(translations);
I18n.setLanguage('pt');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Authenticator.Provider>
      <App />
    </Authenticator.Provider>
  </StrictMode>,
);
