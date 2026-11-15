import type { Context } from 'aws-lambda'
import { listarCatalogo, registrarIntencao, realizarCompra, type PaymentContext, type ToolEvent } from './cloud.ts'

type Event<T> = ToolEvent<T>
function assertContext(context: PaymentContext) {
  if (!context || typeof context.userId !== 'string' || typeof context.conversationId !== 'string') {
    throw new Error('A invocação precisa incluir o contexto autenticado fornecido pelo backend.')
  }
}

export async function listarCatalogoHandler(event: Event<{ categoria?: string }>, _context: Context) {
  assertContext(event.context)
  return listarCatalogo(event)
}
export async function registrarIntencaoHandler(event: Event<{ produto_id: string; quantidade: number }>, _context: Context) {
  assertContext(event.context)
  return registrarIntencao(event)
}
export async function realizarCompraHandler(event: Event<{ intencao_id: string; metodo_pagamento: string }>, _context: Context) {
  assertContext(event.context)
  return realizarCompra(event)
}

