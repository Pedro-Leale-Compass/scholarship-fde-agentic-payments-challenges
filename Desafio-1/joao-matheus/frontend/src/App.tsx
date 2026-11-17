import { Authenticator } from '@aws-amplify/ui-react';
import Chat from './Chat';
import type { AppConfig } from './config';
import './App.css';

interface AppProps {
  config: AppConfig;
}

export default function App({ config }: AppProps) {
  return (
    <Authenticator hideSignUp loginMechanisms={['email']}>
      {({ signOut, user }) => (
        <Chat
          config={config}
          onSair={signOut!}
          email={user?.signInDetails?.loginId || user?.username}
        />
      )}
    </Authenticator>
  );
}
