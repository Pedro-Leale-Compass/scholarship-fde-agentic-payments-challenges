'use client';
import { useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Message = { role: string; text: string };
type Pending = { intencao_id: string; metodo_pagamento: string; produto_id: string; quantidade: number; valor_total: number };
type Conversation = { conversationId: string; title: string };
export function ChatPanel({ apiUrl, onPayment }: { apiUrl: string; onPayment: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [id, setId] = useState('');
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const sending = useRef(false);
  async function request(path: string, body?: unknown) {
    const token = (await fetchAuthSession()).tokens?.idToken;
    if (!token) throw new Error('Entre novamente para continuar.');
    return fetch(new URL(path, apiUrl), { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 125000 : 15000) });
  }
  async function list() {
    const response = await request('conversas');
    if (!response.ok) throw new Error('Não foi possível carregar as conversas.');
    setConversations((await response.json()).conversations);
  }
  useEffect(() => { void list().catch(error => setStatus(error.message)); }, [apiUrl]);
  async function load(conversationId: string) {
    if (sending.current) return;
    setBusy(true); setStatus('Carregando conversa…');
    try {
      const response = await request(`conversas?conversationId=${encodeURIComponent(conversationId)}`);
      if (!response.ok) throw new Error('Não foi possível carregar esta conversa.');
      const value = await response.json();
      setId(conversationId); setMessages(value.messages); setPending(value.busy ? null : value.pending);
      setStatus(value.busy ? 'A resposta ainda está sendo preparada. Aguarde e clique em Atualizar conversa.' : 'Conversa recuperada.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Falha ao carregar.'); }
    finally { setBusy(false); }
  }
  async function send(confirmation?: Pending) {
    if (sending.current || (!confirmation && !text.trim())) return;
    sending.current = true; setBusy(true); setPending(null); setStatus('Preparando resposta…');
    const prompt = confirmation ? `Confirmar compra simulada: ${confirmation.produto_id}, ${confirmation.metodo_pagamento}.` : text.trim();
    const initial = [...messages, { role: 'user', text: prompt }];
    setMessages(initial); setText('');
    let answer = ''; let done = false; let separateNextText = false;
    try {
      const response = await request('chat', { requestId: crypto.randomUUID(), ...(id ? { conversationId: id } : {}),
        ...(confirmation ? { confirmation: { intencao_id: confirmation.intencao_id, metodo_pagamento: confirmation.metodo_pagamento } } : { message: prompt }) });
      if (!response.body) throw new Error('Resposta indisponível.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === 'error') throw new Error(event.message);
            if (event.type === 'start') setId(event.conversationId);
            if (event.type === 'delta') {
              if (separateNextText && event.text) { answer = answer.trimEnd() + '\n\n'; separateNextText = false; }
              answer += event.text; setMessages([...initial, { role: 'assistant', text: answer }]);
            }
            if (event.type === 'status') { setStatus(event.message); if (answer.trim()) separateNextText = true; }
            if (event.type === 'payment') onPayment();
            if (event.type === 'done') { done = true; setPending(event.pending); setStatus('Resposta concluída.'); }
          }
        }
        if (!response.ok || !done) throw new Error('Resposta interrompida. Atualize a conversa antes de repetir.');
      } finally { await reader.cancel().catch(() => {}); }
      await list();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Falha de conexão. Atualize a conversa antes de repetir.');
      onPayment();
    } finally { setBusy(false); sending.current = false; }
  }
  return <section className="chat-panel" aria-label="Assistente de compras">
    <h2>Converse com o assistente</h2>
    <p>Consulte produtos, confira seu limite e prepare uma compra simulada.</p>
    <div className="chat-actions">
      <button className="secondary" disabled={busy} onClick={() => { setId(''); setMessages([]); setPending(null); setStatus('Nova conversa.'); }}>Nova conversa</button>
      {id && <button className="secondary" disabled={busy} onClick={() => void load(id)}>Atualizar conversa</button>}
    </div>
    <label htmlFor="conversations">Conversas salvas</label>
    <select id="conversations" value={id} disabled={busy} onChange={event => event.target.value && void load(event.target.value)}>
      <option value="">Selecione uma conversa</option>
      {id && !conversations.some(c => c.conversationId === id) && <option value={id}>Conversa atual</option>}
      {conversations.map(c => <option key={c.conversationId} value={c.conversationId}>{c.title}</option>)}
    </select>
    <div className="chat-messages" role="log" aria-label="Mensagens">
      {messages.map((message, index) => <div key={index} className={`chat-message ${message.role}`}><strong>{message.role === 'user' ? 'Você' : 'Assistente'}</strong>
        {message.role === 'assistant' ? <div className="chat-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
          table: ({ children }) => <div className="chat-table" role="region" aria-label="Tabela da resposta" tabIndex={0}><table>{children}</table></div>,
          img: ({ alt }) => <span>{alt}</span>,
        }}>{message.text}</Markdown></div> : <p>{message.text}</p>}
      </div>)}
    </div>
    <p role="status">{status}</p>
    {pending && <div className="chat-confirmation"><h3>Confira antes de confirmar</h3>
      <p>{pending.quantidade} × {pending.produto_id} — {pending.valor_total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}, por {pending.metodo_pagamento}.</p>
      <p>A intenção vale por três minutos a partir da criação. Nenhum dinheiro real será movimentado.</p>
      <button disabled={busy} onClick={() => void send(pending)}>Confirmar compra simulada</button>
    </div>}
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <label htmlFor="chat-message">Sua mensagem</label>
      <textarea id="chat-message" maxLength={4000} value={text} disabled={busy} onChange={event => setText(event.target.value)} placeholder="Quero ver os produtos disponíveis" rows={3} />
      <button disabled={busy || !text.trim()} type="submit">{busy ? 'Aguarde…' : 'Enviar mensagem'}</button>
    </form>
  </section>;
}
