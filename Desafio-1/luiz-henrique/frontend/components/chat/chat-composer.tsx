'use client';

import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { useInputHistory } from '@/hooks/use-input-history';
import type { ChatMessage } from '@/lib/chat';

type ChatComposerProps = {
  messages: ChatMessage[];
  loading: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
};

export function ChatComposer({ messages, loading, disabled, onSend }: ChatComposerProps) {
  const userTexts = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  const { input, setInput, handleKeyDown, resetIndex } = useInputHistory(userTexts);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wasLoading = useRef(false);

  useEffect(() => {
    if (wasLoading.current && !loading) {
      inputRef.current?.focus();
    }
    wasLoading.current = loading;
  }, [loading]);

  const canSend = !loading && !disabled && input.trim().length > 0;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;
    onSend(input);
    setInput('');
    resetIndex();
    inputRef.current?.focus();
  }

  return (
    <form onSubmit={submit} className="flex shrink-0 gap-2">
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Digite sua mensagem (ex: listar produtos, comprar com cartão)"
        aria-label="Mensagem"
        disabled={disabled}
        className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Button type="submit" disabled={!canSend}>
        {loading ? 'Enviando...' : 'Enviar'}
      </Button>
    </form>
  );
}
