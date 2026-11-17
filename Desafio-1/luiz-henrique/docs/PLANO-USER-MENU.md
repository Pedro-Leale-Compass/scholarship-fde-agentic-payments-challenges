# Plano — Portar o menu de usuário do `sistema-doacoes-2`

Referência: https://github.com/luiztosk/sistema-doacoes-2
- `src/react-app/components/layout/user-menu.tsx` (componente a portar)
- `src/react-app/components/layout/theme-toggle.tsx`
- `src/react-app/components/ui/{avatar,dropdown-menu,button}.tsx`
- Uso: `public-header.tsx` e `app-header.tsx` (menu alinhado à direita)

Destino: `Desafio-1/luiz-henrique/frontend/` (Next.js 15 App Router, export estático, Tailwind 3, AWS Amplify Auth/Cognito).

## 1. Diferenças relevantes entre os projetos

| Tema | Referência | Destino | Consequência no port |
|---|---|---|---|
| Framework | Vite + React 19 + TanStack Router | Next.js 15 App Router (`output: 'export'`) | Componente precisa de `'use client'`; sem server session |
| Sessão | better-auth + `useQuery(sessionOptions)` | Amplify `Authenticator` (render prop `user`/`signOut`) | Trocar `sessionOptions` por `user` do Amplify |
| UI kit | shadcn base-maia + `@base-ui/react` + Tailwind 4 | Nenhum; Tailwind 3 com tokens HSL shadcn no `tailwind.config.ts` | Portar para shadcn/Radix (Tailwind 3), não copiar `@base-ui` |
| Ícones | `@hugeicons/*` | Nenhum | Usar `lucide-react` (`ChevronDown`, `LogOut`, `Sun`, `Moon`) |
| Tema | `next-themes` com `ThemeProvider` | Sem dark mode | Fase opcional (ver §7) |
| Cadastro | better-auth signup | Cognito `AllowAdminCreateUserOnly` | Não portar “Cadastrar-se”; só “Sair” |

## 2. Arquivos a criar

```
frontend/
├── lib/
│   └── utils.ts                  # cn() com clsx + tailwind-merge
├── components/
│   ├── ui/
│   │   ├── button.tsx            # cva, variantes default/outline/ghost/destructive/link
│   │   ├── avatar.tsx            # @radix-ui/react-avatar
│   │   └── dropdown-menu.tsx     # @radix-ui/react-dropdown-menu (wrapper shadcn)
│   ├── user-menu.tsx             # porta do user-menu.tsx
│   ├── theme-toggle.tsx          # opcional (fase 2)
│   └── app-header.tsx            # header com marca à esquerda e menu à direita
└── app/
    └── providers.tsx             # opcional (ThemeProvider), só se fase 2
```

Dependências novas (`frontend/package.json`):
- obrigatórias: `@radix-ui/react-dropdown-menu`, `@radix-ui/react-avatar`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`
- opcionais: `next-themes`

Não adicionar `@tanstack/react-query`, `better-auth`, `@base-ui/react` nem `@hugeicons/*`: não existem no destino e não são necessários.

## 3. Porta do componente (`components/user-menu.tsx`)

Manter a mesma estrutura visual e os helpers:

```tsx
'use client';

function initials(name?: string | null): string   // 2 primeiras iniciais, "?" se vazio
function firstName(name?: string | null): string  // primeiro nome
```

Trocar a fonte de sessão:

```tsx
// referência
const { data: session } = useQuery(sessionOptions);
if (!session) return <Entrar/Cadastrar>;

// destino
import type { AuthUser } from 'aws-amplify/auth';
export function UserMenu({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  const name = user.attributes?.name ?? user.attributes?.email
    ?? user.signInDetails?.loginId ?? user.username ?? '';
  const email = user.attributes?.email ?? user.signInDetails?.loginId ?? '';
  ...
}
```

Itens do dropdown (mesma ordem da referência):
1. `DropdownMenuLabel`: nome (truncado) + email (truncado, `text-muted-foreground`)
2. `DropdownMenuSeparator`
3. `DropdownMenuItem` “Home” → `Link href="/"` (página única; manter por paridade)
4. `ThemeToggle asMenuItem` (somente na fase 2)
5. `DropdownMenuItem variant="destructive"` “Sair” com ícone `LogOut` → chama `onSignOut`

Trigger igual à referência: `Button variant="ghost"` com `aria-label="Abrir menu do usuário"`, `ChevronDown`, primeiro nome escondido em telas `<sm` (`hidden sm:inline max-w-32 truncate`), `Avatar` circular `size-7` com `AvatarFallback` das iniciais.
Conteúdo: `align="end" className="w-56"`.

Estado deslogado: no destino o `<Authenticator>` já bloqueia a tela inteira, então o menu só renderiza autenticado. Manter um fallback mínimo apenas se o componente for reutilizado fora do Authenticator; sem botão “Cadastrar-se” (Cognito não permite auto cadastro).

## 4. Header (`components/app-header.tsx`)

```tsx
<header className="flex h-14 items-center justify-between border-b border-border px-4">
  <span className="font-semibold">Agente de Pagamentos</span>
  <UserMenu user={user} onSignOut={handleSignOut} />
</header>
```

Adaptação do `app-header.tsx` da referência (que tem só o menu à direita): incluir a marca à esquerda para não perder o título atual da página.

## 5. Integração em `app/page.tsx`

Substituir o bloco inline atual (título + “Bem-vindo” + botão vermelho “Sair”) por:

```tsx
<Authenticator>
  {({ signOut, user }) => (
    <ChatApp config={config} user={user} signOut={signOut} />
  )}
</Authenticator>
```

No `ChatApp`:
- `handleSignOut = () => { signOut(); setToken(null); setMessages([]); }` (preserva a limpeza de estado já existente)
- renderizar `<AppHeader user={user} onSignOut={handleSignOut} />` no topo
- remover `getDisplayName` e o botão inline; saudação pode ir para o header ou permanecer abaixo dele

## 6. Tokens de estilo (`app/globals.css` e `tailwind.config.ts`)

O `tailwind.config.ts` já mapeia `border`, `background`, `primary`, `muted`, etc. para `hsl(var(--...))`, mas `globals.css` não define essas variáveis. Adicionar `:root` e `.dark` (bloco shadcn HSL, equivalente ao `styles.css` da referência convertido para HSL):
- `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--radius`
- `darkMode: ['class']` já está configurado
- garantir que `content` inclua `./components/**/*.{ts,tsx}` e `./lib/**/*.{ts,tsx}` (já inclui `./src/**`, mas não `./components`)

Ajustar classes Tailwind 4 → 3 ao portar componentes:
- manter `size-*` (suportado no 3.4) ou trocar por `h-* w-*` se necessário
- remover variantes `data-open:`/`data-closed:` (Tailwind 4); usar `data-[state=open]:` do Radix
- remover `rounded-4xl`/`rounded-2xl` se não existirem no tema; usar `rounded-md`/`rounded-lg` com `--radius`

## 7. Fase opcional — toggle de tema

Só se o dark mode for desejado:
1. `npm i next-themes`
2. `app/providers.tsx` (`'use client'`) com `<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>`
3. envolver `{children}` no `app/layout.tsx`
4. portar `theme-toggle.tsx` para Radix + `lucide-react`
5. incluir o bloco `.dark` em `globals.css`

Sem essa fase, omitir o item de tema do menu.

## 8. Verificação

- `cd frontend && npm run lint`
- `cd frontend && npm run build` (deve gerar `out/` sem erro; export estático)
- Manual (`npm run dev` com `config.json` válido):
  - avatar mostra iniciais corretas; nome oculto em viewport pequeno
  - dropdown abre alinhado à direita, fecha com Esc/clique fora
  - label mostra nome e email do Cognito (sem UUID)
  - “Sair” encerra a sessão, limpa token/mensagens e volta ao `<Authenticator>`
  - nenhuma regressão no envio de mensagens (`Authorization: Bearer <idToken>`)

## 9. Riscos / decisões

- **Não copiar `@base-ui` diretamente**: os wrappers usam variantes do Tailwind 4 e quebrariam no Tailwind 3. Portar para Radix/shadcn clássico mantém o visual e a acessibilidade.
- **Não introduzir react-query**: `user` já vem do Authenticator; uma segunda fonte de sessão criaria divergência.
- **Ícones**: `lucide-react` evita adicionar o pacote Hugeicons só por 4 ícones.
- **Raio/visual**: a referência usa `rounded-2xl` e sombra forte; aceitar pequena diferença estética para caber no tema shadcn atual.
- Nenhuma mudança em `api/`, `agent/`, `tools/` ou `infra/`.
