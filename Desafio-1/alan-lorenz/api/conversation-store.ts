import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

const dynamoDb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export type ConversationRecord = {
  userId: string;
  messageKey: string;
  conversaId: string;
  tipo: 'message' | 'tool_call';
  role?: 'user' | 'assistant';
  content?: string;
  tool?: string;
  argumentos?: string;
  resultado?: string;
  desfecho?: string;
  data: string;
};

export type ToolEventRecord = {
  name: string;
  arguments: unknown;
  result: unknown;
};

export function conversationMessageKey(
  conversaId: string,
  turnNumber: number,
  ordinal: number,
): string {
  return `${conversaId}#${String(turnNumber).padStart(8, '0')}#${String(ordinal).padStart(9, '0')}`;
}

export function createUserMessageRecord(
  userId: string,
  conversaId: string,
  turnNumber: number,
  content: string,
  createdAt = new Date().toISOString(),
): ConversationRecord {
  return {
    userId,
    messageKey: conversationMessageKey(conversaId, turnNumber, 0),
    conversaId,
    tipo: 'message',
    role: 'user',
    content,
    data: createdAt,
  };
}

export function createCompletionRecords(
  userId: string,
  conversaId: string,
  turnNumber: number,
  assistantContent: string,
  toolEvents: ToolEventRecord[],
  createdAt = new Date().toISOString(),
): ConversationRecord[] {
  const toolRecords: ConversationRecord[] = toolEvents.map((event, index) => {
    const result = isRecord(event.result) ? event.result : undefined;
    const summary =
      event.name === 'listar_catalogo'
        ? {
            produtos: Array.isArray(result?.produtos)
              ? result.produtos.length
              : 0,
          }
        : event.result;
    const outcome =
      event.name === 'listar_catalogo'
        ? 'consultado'
        : typeof result?.erro === 'string'
          ? result.erro
          : typeof result?.status === 'string'
            ? result.status
            : 'desconhecido';

    return {
      userId,
      messageKey: conversationMessageKey(conversaId, turnNumber, index + 1),
      conversaId,
      tipo: 'tool_call' as const,
      tool: event.name,
      argumentos: JSON.stringify(event.arguments ?? {}),
      resultado: JSON.stringify(summary ?? null),
      desfecho: outcome,
      data: createdAt,
    };
  });

  if (assistantContent) {
    toolRecords.push({
      userId,
      messageKey: conversationMessageKey(
        conversaId,
        turnNumber,
        toolEvents.length + 1,
      ),
      conversaId,
      tipo: 'message',
      role: 'assistant',
      content: assistantContent,
      data: createdAt,
    });
  }

  return toolRecords;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function putConversationRecord(
  send: (command: PutCommand) => Promise<unknown>,
  tableName: string,
  record: ConversationRecord,
): Promise<void> {
  await send(
    new PutCommand({
      TableName: tableName,
      Item: record,
    }),
  );
}

export async function saveConversationRecord(
  record: ConversationRecord,
): Promise<void> {
  const tableName = process.env.CONVERSATIONS_TABLE?.trim();
  if (!tableName) {
    throw new Error('CONVERSATIONS_TABLE is required');
  }
  await putConversationRecord(
    (command) => dynamoDb.send(command),
    tableName,
    record,
  );
}
