# Issues conhecidos — tela de login (Amplify `Authenticator`)

Registro dos problemas observados na tela de login do frontend (`frontend/app/page.tsx`, `<Authenticator>` de `@aws-amplify/ui-react`) após o makeover de UI.

## 1. Tela de login sempre no tema claro

**Status:** corrigido em `frontend/app/page.tsx`.

**Sintoma:** o restante do app segue claro/escuro (`next-themes` + classe `.dark`), mas a tela do `Authenticator` permanece clara mesmo com o tema escuro ativo.

**Causa:** o `Authenticator` usa o sistema de temas próprio do Amplify UI, que não lê as variáveis CSS do Tailwind (`--background`, `--foreground`, etc.) nem a classe `.dark` aplicada no `<html>`.

**Correção sugerida:**
- Envolver o `Authenticator` com o `ThemeProvider` do Amplify e sincronizar o `colorMode` com o `next-themes`:

```tsx
import { ThemeProvider, defaultDarkModeOverride } from '@aws-amplify/ui-react';
import { useTheme } from 'next-themes';

const { resolvedTheme } = useTheme();
const colorMode = resolvedTheme === 'dark' ? 'dark' : 'light';

<ThemeProvider colorMode={colorMode} theme={{ name: 'default', overrides: [defaultDarkModeOverride] }}>
  <Authenticator hideSignUp>{/* ... */}</Authenticator>
</ThemeProvider>
```

- `defaultDarkModeOverride` e `ThemeProvider` (com prop `colorMode`) existem no `@aws-amplify/ui-react` instalado (v6).
- Alternativa: usar `theme` customizado com tokens de cor iguais aos do `globals.css` para alinhar a paleta (além do dark mode).

**Observação:** `useTheme()` retorna `resolvedTheme` indefinido no primeiro render; usar fallback `'light'` ou renderizar o `Authenticator` só após montar para evitar flash.

## 2. Ainda aparece “Create account”

**Status:** corrigido em `frontend/app/page.tsx` (prop `hideSignUp`).

**Sintoma:** a tela de login exibe a aba/link de criação de conta, apesar de o Cognito estar com `AllowAdminCreateUserOnly`.

**Causa:** o `Authenticator` mostra a aba de sign-up por padrão, independentemente da política do User Pool. Os usuários são criados apenas por admin (`admin-create-user`).

**Correção sugerida:** passar a prop `hideSignUp` (já existe nos tipos do pacote instalado):

```tsx
<Authenticator hideSignUp>{/* ... */}</Authenticator>
```

- Opcionalmente `initialState="signIn"` para garantir a tela inicial.
- Não remover a política `AllowAdminCreateUserOnly` do CDK; a UI deve apenas não oferecer o cadastro.

## 3. Chrome não oferece salvar usuário/senha

**Status:** não implementado — decisão registrada abaixo.

**Sintoma:** com uma conta já salva no gerenciador de senhas do Chrome, o navegador não oferece atualizar/salvar a senha após o login; às vezes também não preenche automaticamente.

**Causa provável:** o login é 100% client-side (SPA, export estático) e o Amplify envia as credenciais via XHR para o Cognito, sem navegação/submit nativo de formulário reconhecível. O Chrome aciona o prompt de “salvar senha” principalmente em submits de formulário com troca de página; heurísticas em SPAs variam. Campos gerados pelo Amplify também podem não expor `autocomplete="username"` / `autocomplete="current-password"` de forma consistente para o gerenciador.

**Opções de correção (ordem de robustez):**
1. **Migrar para o Cognito Hosted UI / Managed Login (OAuth):** é o caminho mais confiável para integração com gerenciadores de senha, além de suportar MFA e recuperação de senha prontos. Exige mudar o fluxo de auth (redirect OAuth) e ajustar o CDK/app client (callback URLs).
2. **Credential Management API após o login:** capturar usuário/senha no submit e chamar `navigator.credentials.store(new PasswordCredential({ id, password, name }))`. Funciona no Chrome, mas exige acesso à senha em texto claro no cliente e tratamento de cancelamento; não é suportado em todos os browsers.
3. **Ajustar os campos via `formFields`:** garantir `autocomplete`/`name` corretos nos campos de username e password e testar em Chrome atualizado. Melhora o preenchimento, mas não garante o prompt de “salvar” em SPA.

**Decisão pendente:** a opção 1 é a mais alinhada com o desafio (Cognito real, sem auto cadastro), porém é uma mudança de arquitetura de auth; as opções 2 e 3 são incrementais e podem ser avaliadas antes.

**Decisão atual:** não implementar agora.
- A opção 1 (Hosted UI) conflita com a stack documentada no `AGENTS.md` (`Authenticator` + Amplify) e exige mudanças de infra (callback URLs/app client), embora não viole a regra de “sem auto cadastro”.
- A opção 2 (Credential Management API) exige manipular a senha em texto claro no cliente e não tem suporte universal; risco/benefício ruim para o desafio.
- A opção 3 (`formFields`/`autocomplete`) pode ser testada como melhoria incremental, mas não garante o prompt de salvar em SPA.
- Limitação aceita e registrada; o fluxo de login continua funcional com preenchimento manual.

## Referências de código

- `frontend/app/page.tsx` — `<Authenticator>` atual.
- `frontend/app/layout.tsx` + `frontend/app/providers.tsx` — `next-themes`.
- `frontend/app/globals.css` — tokens HSL e bloco `.dark`.
