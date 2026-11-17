import { Authenticator, translations } from "@aws-amplify/ui-react";
import { I18n } from "aws-amplify/utils";
import Chat from "./Chat.js";

I18n.putVocabularies(translations);
I18n.setLanguage("pt");

const componentes = {
  Header() {
    return (
      <div className="login-logo auth-logo">
        <div className="login-logo-icon" aria-hidden="true">🛍️</div>
        <span className="login-logo-text">Assistente de Compras</span>
      </div>
    );
  },
};

/**
 * Login com Amazon Cognito pelo Authenticator do Amplify.
 * `hideSignUp`: nao existe cadastro pela tela -- usuarios sao criados so
 * por convite do administrador (e o user pool recusa cadastro pela API).
 */
export default function App() {
  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      <div className="app-root">
        <Authenticator hideSignUp components={componentes} className="auth-page">
          {({ signOut, user }) => (
            <Chat nome={user?.signInDetails?.loginId ?? user?.username ?? ""} aoSair={() => signOut?.()} />
          )}
        </Authenticator>
      </div>
    </>
  );
}
