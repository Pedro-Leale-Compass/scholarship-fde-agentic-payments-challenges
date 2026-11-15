'use client'

import { useEffect, useRef, useState } from 'react'
import { Amplify } from 'aws-amplify'
import { fetchAuthSession } from 'aws-amplify/auth'
import { Authenticator } from '@aws-amplify/ui-react'
import Markdown from 'react-markdown'

type RuntimeConfig = { apiUrl: string; userPoolId: string; userPoolClientId: string }
type DisplayMessage = { role: 'user' | 'assistant'; content: string }
type SseEvent = { event: string; data: unknown }

function parseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    const lines = block.split('\n')
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
    if (data) events.push({ event: eventName, data: JSON.parse(data) })
  }
  return { events, rest }
}

function Chat({ config, user, signOut }: { config: RuntimeConfig; user: { username: string }; signOut?: () => void }) {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const didLoad = useRef(false)

  useEffect(() => {
    if (didLoad.current) return
    didLoad.current = true
    const saved = sessionStorage.getItem('payments_conversation_id')
    if (!saved) return
    let cancelled = false
    void (async () => {
      try {
        const session = await fetchAuthSession()
        const token = session.tokens?.idToken?.toString()
        if (!token) throw new Error('Sessão do Cognito indisponível.')
        const response = await fetch(config.apiUrl.replace(/\/$/, '') + '/conversations/' + encodeURIComponent(saved), {
          headers: { Authorization: 'Bearer ' + token },
        })
        if (!response.ok) throw new Error('Não foi possível carregar esta conversa.')
        const payload = await response.json() as { messages?: DisplayMessage[] }
        if (!cancelled) {
          setConversationId(saved)
          setMessages(Array.isArray(payload.messages) ? payload.messages : [])
        }
      } catch {
        sessionStorage.removeItem('payments_conversation_id')
      }
    })()
    return () => { cancelled = true }
  }, [config.apiUrl])

  function newConversation() {
    sessionStorage.removeItem('payments_conversation_id')
    setConversationId(null)
    setMessages([])
    setError('')
  }

  async function send(event: { preventDefault(): void }) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt || busy) return
    setError('')
    setInput('')
    setMessages((current) => [...current, { role: 'user', content: prompt }, { role: 'assistant', content: '' }])
    setBusy(true)

    try {
      const session = await fetchAuthSession()
      const token = session.tokens?.idToken?.toString()
      if (!token) throw new Error('Sua sessão expirou. Entre novamente.')
      const response = await fetch(config.apiUrl.replace(/\/$/, '') + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ message: prompt, ...(conversationId ? { conversationId } : {}) }),
      })
      if (!response.ok || !response.body) {
        if (response.status === 401) signOut?.()
        throw new Error(response.status === 401 ? 'Sua sessão expirou. Entre novamente.' : 'Não foi possível conectar ao assistente.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = parseEvents(buffer)
        buffer = parsed.rest
        for (const item of parsed.events) {
          const data = item.data as { conversationId?: string; response?: string; message?: string }
          if (data.conversationId && data.conversationId !== conversationId) {
            setConversationId(data.conversationId)
            sessionStorage.setItem('payments_conversation_id', data.conversationId)
          }
          if (item.event === 'message') {
            setMessages((current) => {
              const updated = [...current]
              updated[updated.length - 1] = { role: 'assistant', content: data.response ?? '' }
              return updated
            })
          }
          if (item.event === 'error') throw new Error(data.message ?? 'Não foi possível responder agora.')
        }
      }
      if (buffer.trim()) {
        const parsed = parseEvents(buffer + '\n\n')
        for (const item of parsed.events) {
          const data = item.data as { conversationId?: string; response?: string; message?: string }
          if (data.conversationId) {
            setConversationId(data.conversationId)
            sessionStorage.setItem('payments_conversation_id', data.conversationId)
          }
          if (item.event === 'message') {
            setMessages((current) => {
              const updated = [...current]
              updated[updated.length - 1] = { role: 'assistant', content: data.response ?? '' }
              return updated
            })
          }
          if (item.event === 'error') throw new Error(data.message ?? 'Não foi possível responder agora.')
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Falha ao enviar mensagem.'
      setMessages((current) => {
        const updated = [...current]
        updated[updated.length - 1] = { role: 'assistant', content: 'Erro: ' + message }
        return updated
      })
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex h-screen max-w-5xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between border-b pb-3">
        <div>
          <h1 className="text-base font-bold">Chat de Pagamentos</h1>
          <p className="text-xs text-gray-500">Usuário: <strong>{user.username}</strong></p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={newConversation} disabled={busy} className="rounded border px-3 py-1.5 text-xs disabled:opacity-50">Nova conversa</button>
          <button type="button" onClick={() => signOut?.()} className="rounded border px-3 py-1.5 text-xs">Sair</button>
        </div>
      </header>
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <section className="flex-1 space-y-3 overflow-y-auto" aria-live="polite">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">
            <p className="font-semibold">Olá, {user.username}! Como posso ajudar?</p>
            <p className="mt-1 text-xs">Consulte o catálogo ou peça para comprar um produto.</p>
          </div>
        )}
        {messages.map((message, index) => message.role === 'user' ? (
          <div key={index} className="ml-auto w-fit max-w-[80%] whitespace-pre-wrap rounded bg-blue-600 px-3 py-2 text-white shadow-sm">{message.content}</div>
        ) : (
          <div key={index} className="prose-chat w-fit max-w-[80%] rounded bg-gray-200 px-3 py-2 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
            {message.content ? <Markdown>{message.content}</Markdown> : busy ? 'Pensando…' : ''}
          </div>
        ))}
      </section>
      <form onSubmit={send} className="flex gap-2">
        <input
          className="flex-1 rounded border border-gray-300 bg-transparent px-3 py-2 text-sm focus:border-blue-600 focus:outline-none dark:border-gray-700"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Digite sua mensagem…"
          disabled={busy}
        />
        <button className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy}>Enviar</button>
      </form>
    </main>
  )
}

export default function Page() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null)
  const [configError, setConfigError] = useState('')

  useEffect(() => {
    void fetch('/config.json', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('A configuração da aplicação não foi publicada.')
        return await response.json() as RuntimeConfig
      })
      .then((value) => {
        if (!value.apiUrl || !value.userPoolId || !value.userPoolClientId) throw new Error('A configuração publicada está incompleta.')
        Amplify.configure({ Auth: { Cognito: { userPoolId: value.userPoolId, userPoolClientId: value.userPoolClientId } } })
        setConfig(value)
      })
      .catch((caught) => setConfigError(caught instanceof Error ? caught.message : 'Erro ao carregar a configuração.'))
  }, [])

  if (!config) return <main className="mx-auto flex h-screen max-w-md flex-col justify-center p-4 text-sm">{configError || 'Carregando aplicação…'}</main>

  return (
    <Authenticator hideSignUp loginMechanisms={['email']}>
      {({ signOut, user }) => user
        ? <Chat config={config} user={user} signOut={signOut} />
        : <main className="mx-auto flex h-screen max-w-md flex-col justify-center p-4 text-sm">Carregando sessão…</main>}
    </Authenticator>
  )
}

