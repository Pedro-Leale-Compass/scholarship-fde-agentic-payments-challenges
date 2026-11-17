import { randomBytes } from 'node:crypto';
import {
  DEFAULT_LIMIT_CENTS,
  DuplicateIntentionError,
  INTENTION_VALIDITY_MINUTES,
  PurchaseConflictError,
  type Intention,
  type PaymentMethod,
  type PaymentStore,
  type Product,
  type PurchaseRejected,
  type Rejected,
  type UserProfile,
} from './types.ts';

const STOCK_UNAVAILABLE_STATUS = 'cancelada_estoque';
const MAX_INTENTION_ID_ATTEMPTS = 5;

function rejected(erro: Rejected['erro'], mensagem: string): Rejected {
  return { status: 'recusado', erro, mensagem };
}

function purchaseRejected(
  erro: PurchaseRejected['erro'],
  mensagem: string,
): PurchaseRejected {
  return { status: 'recusado', erro, mensagem };
}

export function generateIntentionId(): string {
  return `int_${randomBytes(3).toString('hex')}`;
}

export function generateTransactionId(): string {
  return `tx_${randomBytes(8).toString('hex')}`;
}

function isDuplicateIntention(error: unknown): boolean {
  return error instanceof DuplicateIntentionError;
}

function isIntentionExpired(intention: Intention, now: Date): boolean {
  const expiration = new Date(intention.expira_em).getTime();
  return !Number.isFinite(expiration) || now.getTime() > expiration;
}

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return value === 'cartao' || value === 'pix';
}

function validatePurchase(
  intention: Intention | undefined,
  user: UserProfile | undefined,
  userId: string,
  conversaId: string,
  paymentMethod: unknown,
  now: Date,
): PurchaseRejected | undefined {
  if (
    !intention ||
    !user ||
    intention.userId !== userId ||
    intention.conversaId !== conversaId
  ) {
    return purchaseRejected(
      'INTENCAO_INVALIDA',
      'Intenção inválida para o usuário autenticado.',
    );
  }
  if (intention.status === STOCK_UNAVAILABLE_STATUS) {
    return purchaseRejected(
      'INTENCAO_INVALIDA',
      'O estoque desta intenção não está mais disponível. Registre uma nova intenção.',
    );
  }
  if (intention.status !== 'pendente') {
    return purchaseRejected(
      'INTENCAO_JA_PAGA',
      'Esta intenção de compra já foi utilizada.',
    );
  }
  if (isIntentionExpired(intention, now)) {
    return purchaseRejected(
      'INTENCAO_EXPIRADA',
      'Esta intenção de compra expirou. Registre uma nova intenção.',
    );
  }
  if (!isPaymentMethod(paymentMethod)) {
    return purchaseRejected(
      'METODO_INVALIDO',
      'Método de pagamento inválido. Escolha cartao ou pix.',
    );
  }
  if (intention.valor_total_cents > user.limite_restante_cents) {
    return purchaseRejected(
      'LIMITE_EXCEDIDO',
      'O valor da compra excede o limite restante.',
    );
  }
}

function catalogProduct(product: Product) {
  const { preco_cents, categoria: _categoria, ...publicProduct } = product;
  return { ...publicProduct, preco: preco_cents / 100 };
}

export function createPaymentTools(
  store: PaymentStore,
  options: {
    initialLimitCents?: number;
    now?: () => Date;
    createIntentionId?: () => string;
    createTransactionId?: () => string;
  } = {},
) {
  const initialLimitCents = options.initialLimitCents ?? DEFAULT_LIMIT_CENTS;
  if (!Number.isSafeInteger(initialLimitCents) || initialLimitCents < 0) {
    throw new Error('initialLimitCents must be a non-negative safe integer');
  }
  const now = options.now ?? (() => new Date());
  const nextIntentionId = options.createIntentionId ?? generateIntentionId;
  const nextTransactionId = options.createTransactionId ?? generateTransactionId;

  async function listarCatalogo(args: { categoria?: unknown } = {}) {
    const category =
      typeof args.categoria === 'string' ? args.categoria.trim().toLowerCase() : '';
    const products = await store.listProducts();
    return {
      produtos: products
        .filter((product) => !category || product.categoria.toLowerCase() === category)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(catalogProduct),
    };
  }

  async function registrarIntencao(
    userId: string,
    conversaId: string,
    args: { produto_id?: unknown; quantidade?: unknown },
  ) {
    const productId = typeof args.produto_id === 'string' ? args.produto_id.trim() : '';
    if (!productId) {
      return rejected('PRODUTO_INEXISTENTE', 'Produto não encontrado no catálogo.');
    }

    const quantity = args.quantidade;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
      return rejected(
        'QUANTIDADE_INVALIDA',
        'Quantidade deve ser um inteiro maior que zero.',
      );
    }

    const product = await store.getProduct(productId);
    if (!product) {
      return rejected('PRODUTO_INEXISTENTE', 'Produto não encontrado no catálogo.');
    }
    if (quantity > product.estoque) {
      return rejected(
        'ESTOQUE_INSUFICIENTE',
        'Estoque insuficiente para a quantidade solicitada.',
      );
    }

    await store.ensureUser(userId, initialLimitCents);
    const createdAt = now();
    const expiresAt = new Date(
      createdAt.getTime() + INTENTION_VALIDITY_MINUTES * 60_000,
    ).toISOString();
    const intentionBase = {
      produto_id: product.id,
      quantidade: quantity,
      valor_total_cents: product.preco_cents * quantity,
      status: 'pendente',
      userId,
      conversaId,
      criada_em: createdAt.toISOString(),
      expira_em: expiresAt,
    };

    for (let attempt = 0; attempt < MAX_INTENTION_ID_ATTEMPTS; attempt++) {
      const intention: Intention = {
        ...intentionBase,
        intentionId: nextIntentionId(),
      };
      try {
        await store.putIntention(intention);
        return {
          intencao_id: intention.intentionId,
          produto_id: product.id,
          quantidade: quantity,
          valor_total: intention.valor_total_cents / 100,
          moeda: product.moeda,
          status: 'pendente' as const,
          expira_em: expiresAt,
          valido_por_minutos: INTENTION_VALIDITY_MINUTES,
        };
      } catch (error) {
        if (!isDuplicateIntention(error)) throw error;
      }
    }
    throw new Error('Could not generate a unique intention id after five attempts');
  }

  async function refreshPurchaseFailure(
    userId: string,
    conversaId: string,
    intentionId: string,
    paymentMethod: unknown,
    at: Date,
  ): Promise<PurchaseRejected | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const [intention, user] = await Promise.all([
        store.getIntention(intentionId),
        store.getUser(userId),
      ]);
      const validation = validatePurchase(
        intention,
        user,
        userId,
        conversaId,
        paymentMethod,
        at,
      );
      if (validation || !intention) return validation;

      const product = await store.getProduct(intention.produto_id);
      if (product && product.estoque >= intention.quantidade) return undefined;
      if (
        await store.cancelIntention(intention)
      ) {
        return purchaseRejected(
          'INTENCAO_INVALIDA',
          'O estoque desta intenção não está mais disponível. Registre uma nova intenção.',
        );
      }
    }
    throw new PurchaseConflictError();
  }

  async function realizarCompra(
    userId: string,
    conversaId: string,
    args: { intencao_id?: unknown; metodo_pagamento?: unknown },
  ) {
    const intentionId =
      typeof args.intencao_id === 'string' ? args.intencao_id : '';
    const paymentMethod = args.metodo_pagamento;
    const at = now();
    const [intention, user] = await Promise.all([
      store.getIntention(intentionId),
      store.getUser(userId),
    ]);
    const validation = validatePurchase(
      intention,
      user,
      userId,
      conversaId,
      paymentMethod,
      at,
    );
    if (validation) return validation;
    if (!intention || !user) {
      throw new Error('Validated purchase is missing its intention or user');
    }
    if (!isPaymentMethod(paymentMethod)) {
      throw new Error('Validated purchase has an invalid payment method');
    }

    const product = await store.getProduct(intention.produto_id);
    if (!product || product.estoque < intention.quantidade) {
      const changed = await store.cancelIntention(intention);
      if (!changed) {
        return (
          (await refreshPurchaseFailure(
            userId,
            conversaId,
            intentionId,
            paymentMethod,
            at,
          )) ??
          purchaseRejected(
            'INTENCAO_INVALIDA',
            'O estoque desta intenção não está mais disponível. Registre uma nova intenção.',
          )
        );
      }
      return purchaseRejected(
        'INTENCAO_INVALIDA',
        'O estoque desta intenção não está mais disponível. Registre uma nova intenção.',
      );
    }

    const transactionId = nextTransactionId();
    const transactionDate = at.toISOString();
    try {
      await store.completePurchase({
        intention,
        userId,
        transactionId,
        paymentMethod,
        transactionDate,
      });
    } catch (error) {
      if (!(error instanceof PurchaseConflictError)) throw error;
      const conflict = await refreshPurchaseFailure(
        userId,
        conversaId,
        intentionId,
        paymentMethod,
        at,
      );
      if (conflict) return conflict;
      throw error;
    }

    const updatedUser = await store.getUser(userId);
    if (!updatedUser) {
      throw new Error('Purchase committed but the user balance could not be read');
    }
    return {
      status: 'aprovado' as const,
      transacao_id: transactionId,
      intencao_id: intention.intentionId,
      valor: intention.valor_total_cents / 100,
      metodo_pagamento: paymentMethod,
      limite_restante: updatedUser.limite_restante_cents / 100,
      data: transactionDate,
    };
  }

  return { listarCatalogo, registrarIntencao, realizarCompra };
}
