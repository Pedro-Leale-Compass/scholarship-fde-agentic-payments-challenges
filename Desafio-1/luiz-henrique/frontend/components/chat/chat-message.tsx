'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { ChatMessage as ChatMessageType } from '@/lib/chat';
import { cn } from '@/lib/utils';

export function ChatMessage({ message }: { message: ChatMessageType }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="ml-auto w-fit max-w-[80%] whitespace-pre-wrap break-words rounded-lg bg-primary px-3 py-2 text-primary-foreground">
        {message.content}
      </div>
    );
  }

  const isError = !isUser && message.content.startsWith('Erro:');

  return (
    <div
      role={isError ? 'alert' : undefined}
      className={cn(
        'mr-auto w-fit max-w-[80%] break-words rounded-lg px-3 py-2',
        isError
          ? 'border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
          : 'bg-muted text-muted-foreground',
        'prose-chat',
        !isError && 'text-foreground',
      )}
    >
      {message.content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      ) : (
        <span className="text-muted-foreground">…</span>
      )}
    </div>
  );
}
