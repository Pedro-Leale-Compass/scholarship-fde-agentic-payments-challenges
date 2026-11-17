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

  return (
    <div
      className={cn(
        'mr-auto w-fit max-w-[80%] break-words rounded-lg bg-muted px-3 py-2 text-muted-foreground',
        'prose-chat text-foreground',
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
