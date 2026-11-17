> **HISTÓRICO — arquivado em 2026-11-17.** Este documento descreve um estado antigo ou um plano concluído. Não use como fonte de verdade. Consulte `docs/README.md` e o código atual.

# Plano — Portar mecânicas básicas de chat do `squad-03-desafio-MCP-agentic`

Referência: https://github.com/luiztosk/squad-03-desafio-MCP-agentic (`ollama-chat/`)
Arquivo principal: `ollama-chat/src/app/page.tsx` (265 linhas)
Estilos: `ollama-chat/src/app/globals.css`

Destino: `Desafio-1/luiz-henrique/frontend/` (Next.js 15 App Router, export estático, Tailwind 3, Amplify/Cognito, API própria não-streaming).

## 1. O que entra e o que fica de fora

### Entra (mecânicas básicas)
| Mecânica | Referência | Situação no destino |
|---|---|---|
| Lista de mensagens com bolhas (usuário à direita, agente à esquerda) | `page.tsx:194-222` | Já existe com estilos inline; reimplementar com Tailwind |
| Renderização Markdown das respostas | `page.tsx:218` | Já existe (`react-markdown` + `remark-gfm`) |
| Composer com `form` + botão desabilitado durante envio | `page.tsx:224-235` | Hoje é botão + Enter; trocar por `<form onSubmit>` |
| Indicador de resposta pendente (`…`) | `page.tsx:218` | Adicionar placeholder enquanto `loading` |
| Estado vazio (“Envie uma mensagem…”) | `page.tsx:195-201` | Adaptar texto |
| Fallbacks de erro / resposta vazia | `page.tsx:157-162` | Já existe parcialmente; unificar |
| Histórico de entrada com ↑/↓ | `page.tsx:77-99` | Não existe; portar |
| Limpeza de input + reset do índice ao enviar | `page.tsx:118-119` | Adicionar |
| Rolagem automática para o fim | ausente na referência (item aberto no `docs/TODO.md`) | Adicionar junto com o port |

### Não entra (explicitamente fora de escopo)
- **Visualizador API/MCP**: painel lateral `peek` com `messages[i].sent` e `messages[i].tools` (`page.tsx:237-262`) — é o “api/mcp visualizer”.
- Tipos `Turn`, `ToolRun`, acúmulo de `tool` chunks (`page.tsx:9-11, 148-151`).
- Alternância “Sem memória / Histórico completo” (`page.tsx:20-23, 111-113`); o destino sempre envia histórico completo (requisito do desafio).
- Autenticação por `localStorage` + `/login` + `/api/auth` (`page.tsx:40-64, 167-177`); o destino usa `<Authenticator>` e `fetchAuthSession()`.
- `SYSTEM_PROMPT` no cliente (`page.tsx:13-18`); o system prompt vive no agente Strands.
- Streaming NDJSON (`page.tsx:132-155`) e dependências MCP/Ollama; a API atual retorna `{ reply }` de uma vez.

Nenhuma alteração em `api/`, `agent/`, `tools/` ou `infra/`.

## 2. Diferenças de contrato a acomodar

| Tema | Referência | Destino |
|---|---|---|
| Endpoint | `POST /api/chat` (route handler) | `POST ${config.apiUrl}/chat` |
| Auth | `Authorization: Bearer <chat-token>` do localStorage | `Bearer <idToken>` via `fetchAuthSession()` |
| Corpo | `{ messages: [{ role, content: string }] }` | `{ messages: [{ role, content: [{ text }] }] }` |
| Resposta | NDJSON incremental (`message.content`) | JSON único: `data.reply ?? data.message` |
| Erros | `res.text()` / `chunk.error` | `data.error ?? data.message ?? HTTP <status>`; 401 tem tratamento próprio |
| Rotas | `/login` | `<Authenticator>` já bloqueia a tela |

## 3. Estrutura de arquivos proposta

```
frontend/
├── components/
│   └── chat/
│       ├── chat-thread.tsx      # lista + estado vazio + âncora de scroll
│       ├── chat-message.tsx     # bolha user/assistant + Markdown
│       └── chat-composer.tsx    # form, input, botão
├── hooks/
│   ├── use-chat.ts              # estado, envio, erros, loading
│   └── use-input-history.ts     # ↑/↓
└── app/
    ├── page.tsx                 # ChatApp usa os componentes acima
    └── globals.css              # bloco .prose-chat
```

A extração em componentes é opcional; se preferir mínimo, manter tudo em `page.tsx` e criar só `hooks/use-chat.ts`. Recomendado extrair porque o `page.tsx` atual já tem ~216 linhas e o menu de usuário (`docs/PLANO-USER-MENU.md`) também vai consumir `components/`.

## 4. Passo a passo

### 4.1 Tipos e hook de envio (`hooks/use-chat.ts`)

```ts
export type ChatRole = 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

export function useChat(config: RuntimeConfig | null) {
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  // fetchAuthSession() -> idToken (mover do page.tsx)

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading || !config || !token) return;

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const history = [...messages, userMessage];
    setMessages([...history, { role: 'assistant', content: '' }]); // placeholder "…"
    setLoading(true);

    try {
      const res = await fetch(`${config.apiUrl}/chat`, { /* headers + body atuais */ });
      if (res.status === 401) throw new Error('401 não autorizado — faça login novamente.');
      if (!res.ok) { /* mesma extração de erro atual */ }
      const data = await res.json();
      const reply = data.reply || data.message || '(resposta vazia do modelo)';
      setMessages([...history, { role: 'assistant', content: reply }]);
    } catch (err) {
      setMessages([...history, { role: 'assistant', content: `Erro: ${...}` }]);
    } finally {
      setLoading(false);
    }
  }

  return { messages, loading, send, reset: () => setMessages([]), token };
}
```

Notas:
- **Enviar histórico completo** (igual à referência e ao requisito 6): incluir todas as mensagens anteriores, ignorando placeholders vazios.
- Não reenviar a mensagem do usuário duas vezes: `history` já a contém.
- `reset()` é usado no “Sair” (`signOut` do `Authenticator`) junto com `setToken(null)`.

### 4.2 Mensagens (`components/chat/chat-message.tsx`)

Porta de `page.tsx:203-221`, sem rótulos (“Você”/“Agente”) e sem o bug de rótulo colado:

```tsx
<div className={isUser
  ? 'ml-auto w-fit max-w-[80%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-primary-foreground'
  : 'mr-auto w-fit max-w-[80%] rounded-lg bg-muted px-3 py-2 text-foreground'}>
  {isUser ? content : content ? <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown> : '…'}
</div>
```

Alinhamento + cor substituem os rótulos atuais e resolvem o item aberto do `TODO.md` (“Você” colado ao texto).

### 4.3 Thread (`components/chat/chat-thread.tsx`)

Porta de `page.tsx:194-222`:

```tsx
<div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
  {messages.length === 0 && (
    <p className="text-sm text-muted-foreground">
      Envie uma mensagem para iniciar a conversa (ex.: listar produtos, comprar com cartão).
    </p>
  )}
  {messages.map((m, i) => <ChatMessage key={i} message={m} />)}
  <div ref={endRef} />
</div>
```

Rolagem automática (novo, do TODO):
```ts
useEffect(() => {
  endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}, [messages, loading]);
```
Opcional: só rolar se o usuário estiver perto do fim, para não atrapalhar leitura de histórico.

### 4.4 Composer + histórico de entrada

`components/chat/chat-composer.tsx` porta `page.tsx:224-235` e `77-99`:

```tsx
const { input, setInput, onKeyDown, resetIndex } = useInputHistory(userTexts);
<form onSubmit={(e) => { e.preventDefault(); if (!loading) send(input); setInput(''); resetIndex(); }} className="flex gap-2">
  <input
    className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    value={input}
    onChange={(e) => setInput(e.target.value)}
    onKeyDown={onKeyDown}
    placeholder="Pergunte alguma coisa…"
    disabled={loading || !token}
  />
  <Button type="submit" disabled={loading || !input.trim() || !token}>
    {loading ? 'Enviando...' : 'Enviar'}
  </Button>
</form>
```

`useInputHistory` (porta literal de `handleKeyDown`, `page.tsx:77-99`):
- `userTexts` derivado de `messages.filter(m => m.role === 'user')`
- `ArrowUp`: do fim para o início; `ArrowDown`: avança e limpa no fim
- qualquer outra tecla zera o índice
- `resetIndex()` após envio

### 4.5 Layout da página (`app/page.tsx`)

- Remover os estilos inline de mensagens/composer e o botão inline “Sair” (substituído pelo header/menu do plano anterior).
- Estrutura: `<main className="mx-auto flex h-screen max-w-2xl flex-col gap-4 p-4">` com header, `ChatThread` (`flex-1 min-h-0`) e `ChatComposer`.
- `getDisplayName` pode permanecer no header até o menu de usuário entrar.
- Manter o fluxo atual de `config.json` + `Amplify.configure` + `<Authenticator>` intacto.

### 4.6 Estilos Markdown (`app/globals.css`)

Adicionar o bloco `.prose-chat` da referência (`ollama-chat/src/app/globals.css`), trocando cores fixas (`rgb(0 0 0 / …)`) pelos tokens do tema:
- `code`/`pre`: `background: hsl(var(--muted))`
- `blockquote`: `border-left-color: hsl(var(--border))`
- tabelas: `border-color: hsl(var(--border))`
- `a`: `color: hsl(var(--primary))`
- manter `> :first-child { margin-top: 0 }` / `> :last-child { margin-bottom: 0 }`

## 5. Verificação

- `cd frontend && npm run lint`
- `cd frontend && npm run build` (export estático gera `out/`)
- `npm run dev` com `public/config.json` válido:
  - enviar mensagem → bolha do usuário à direita, `…` e depois Markdown à esquerda
  - Enter envia; botão desabilita enquanto `loading`
  - ↑ recupera mensagens anteriores; ↓ avança e limpa
  - resposta com tabela/código renderiza no bloco `.prose-chat`
  - erro 401/HTTP aparece como mensagem “Erro: …” sem quebrar a thread
  - rolagem acompanha novas mensagens
  - layout em viewport estreito (bolhas `max-w-[80%]`), sem overflow horizontal

## 6. Riscos / decisões

- **Sem streaming**: a API atual devolve `{ reply }`; o efeito “digitando” da referência não é portado. Se `api/` passar a transmitir (NDJSON/SSE), criar uma fase 2 só para o parser, mantendo o mesmo `useChat`.
- **Sem react-query/TanStack**: estado local é suficiente e já é o padrão do frontend atual.
- **Sem painel de debug**: `Turn.sent`/`Turn.tools` e o `peek` ficam de fora por pedido explícito.
- **`content` em array**: o payload do destino usa `content: [{ text }]`; não copiar o formato string da referência.
- **Não adicionar `@modelcontextprotocol/sdk`, `jsonwebtoken` ou `react-markdown` duplicado** (o destino já tem `react-markdown` e `remark-gfm`).
