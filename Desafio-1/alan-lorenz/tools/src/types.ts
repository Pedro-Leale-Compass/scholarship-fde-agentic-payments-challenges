export const DEFAULT_LIMIT_CENTS = 100_000;
export const INTENTION_VALIDITY_MINUTES = 5;

export type Product = {
  id: string;
  nome: string;
  preco_cents: number;
  moeda: string;
  estoque: number;
  categoria: string;
};

export type Intention = {
  intentionId: string;
  produto_id: string;
  quantidade: number;
  valor_total_cents: number;
  status: string;
  userId: string;
  conversaId: string;
  criada_em: string;
  expira_em: string;
};

export type UserProfile = {
  userId: string;
  limite_cents: number;
  limite_restante_cents: number;
};

export type Rejected = {
  status: 'recusado';
  erro: 'PRODUTO_INEXISTENTE' | 'QUANTIDADE_INVALIDA' | 'ESTOQUE_INSUFICIENTE';
  mensagem: string;
};

export type PurchaseRejected = {
  status: 'recusado';
  erro:
    | 'INTENCAO_INVALIDA'
    | 'INTENCAO_EXPIRADA'
    | 'INTENCAO_JA_PAGA'
    | 'LIMITE_EXCEDIDO'
    | 'METODO_INVALIDO';
  mensagem: string;
};

export type PaymentMethod = 'cartao' | 'pix';

export type PurchaseTransaction = {
  intention: Intention;
  userId: string;
  transactionId: string;
  paymentMethod: PaymentMethod;
  transactionDate: string;
};

export interface PaymentStore {
  listProducts(): Promise<Product[]>;
  getProduct(productId: string): Promise<Product | undefined>;
  getIntention(intentionId: string): Promise<Intention | undefined>;
  getUser(userId: string): Promise<UserProfile | undefined>;
  ensureUser(userId: string, initialLimitCents: number): Promise<UserProfile>;
  putIntention(intention: Intention): Promise<void>;
  cancelIntention(intention: Intention): Promise<boolean>;
  completePurchase(transaction: PurchaseTransaction): Promise<void>;
}

export class DuplicateIntentionError extends Error {
  constructor() {
    super('An intention with this id already exists');
    this.name = 'DuplicateIntentionError';
  }
}

export class PurchaseConflictError extends Error {
  constructor(cause?: unknown) {
    super('The purchase conditions changed before the transaction committed', { cause });
    this.name = 'PurchaseConflictError';
  }
}
