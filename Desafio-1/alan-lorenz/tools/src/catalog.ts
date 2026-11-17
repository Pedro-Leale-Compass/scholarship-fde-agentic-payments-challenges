import type { Product } from './types.ts';

export const PRODUCTS: readonly Product[] = [
  {
    id: 'prod_001',
    nome: 'Fone Bluetooth',
    preco_cents: 24990,
    moeda: 'BRL',
    estoque: 20,
    categoria: 'audio',
  },
  {
    id: 'prod_002',
    nome: 'Teclado Mecânico',
    preco_cents: 45990,
    moeda: 'BRL',
    estoque: 15,
    categoria: 'perifericos',
  },
  {
    id: 'prod_003',
    nome: 'Monitor 27" 144Hz',
    preco_cents: 189990,
    moeda: 'BRL',
    estoque: 8,
    categoria: 'monitores',
  },
  {
    id: 'prod_004',
    nome: 'Cadeira Gamer',
    preco_cents: 69990,
    moeda: 'BRL',
    estoque: 5,
    categoria: 'moveis',
  },
  {
    id: 'prod_005',
    nome: 'Mochila pra Notebook',
    preco_cents: 18990,
    moeda: 'BRL',
    estoque: 30,
    categoria: 'acessorios',
  },
];
