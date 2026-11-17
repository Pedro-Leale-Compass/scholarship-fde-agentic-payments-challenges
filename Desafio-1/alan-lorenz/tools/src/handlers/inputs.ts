import type { PaymentStore } from '../types.ts';
import { createPaymentTools } from '../tools.ts';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ToolContext = {
  userId: string;
  conversaId: string;
  arguments: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolContext(event: unknown): ToolContext {
  if (!isRecord(event) || !isRecord(event.authenticatedContext)) {
    throw new Error('Authenticated tool context is required');
  }

  const { userId, conversaId } = event.authenticatedContext;
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('Authenticated user id is required');
  }
  if (typeof conversaId !== 'string' || !UUID_V4.test(conversaId.trim())) {
    throw new Error('A valid conversation UUID v4 is required');
  }
  if (!isRecord(event.arguments)) {
    throw new Error('Tool arguments must be an object');
  }

  return {
    userId: userId.trim(),
    conversaId: conversaId.trim().toLowerCase(),
    arguments: event.arguments,
  };
}

export function createToolHandlers(store: PaymentStore) {
  const tools = createPaymentTools(store);

  return {
    listar_catalogo: async (event: unknown) => {
      const { arguments: args } = parseToolContext(event);
      return tools.listarCatalogo({ categoria: args.categoria });
    },
    registrar_intencao: async (event: unknown) => {
      const { userId, conversaId, arguments: args } = parseToolContext(event);
      return tools.registrarIntencao(userId, conversaId, {
        produto_id: args.produto_id,
        quantidade: args.quantidade,
      });
    },
    realizar_compra: async (event: unknown) => {
      const { userId, conversaId, arguments: args } = parseToolContext(event);
      return tools.realizarCompra(userId, conversaId, {
        intencao_id: args.intencao_id,
        metodo_pagamento: args.metodo_pagamento,
      });
    },
  };
}
