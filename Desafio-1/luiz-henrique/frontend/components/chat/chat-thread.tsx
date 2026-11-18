'use client';

import { useEffect, useRef } from 'react';

import type { ChatMessage as ChatMessageType } from '@/lib/chat';
import { ChatMessage } from '@/components/chat/chat-message';

type ChatThreadProps = {
  messages: ChatMessageType[];
  loading: boolean;
};

export function ChatThread({ messages, loading }: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
      {messages.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Envie uma mensagem para iniciar a conversa (ex.: listar produtos, comprar com cartão).
        </p>
      )}
      {messages.map((message, index) => (
        <ChatMessage key={index} message={message} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
