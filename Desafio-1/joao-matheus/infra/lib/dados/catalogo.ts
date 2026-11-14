export interface ItemCatalogo {
  produto_id: string;
  nome: string;
  preco: number;
  descricao: string;
  moeda: string;
}

export const CATALOGO_INICIAL: ItemCatalogo[] = [
  {
    produto_id: 'prod_001',
    nome: 'Fone Bluetooth',
    preco: 249.90,
    descricao: 'Fone de ouvido sem fio bluetooth com cancelamento de ruído',
    moeda: 'BRL',
  },
  {
    produto_id: 'prod_002',
    nome: 'Carregador Turbo',
    preco: 80.00,
    descricao: 'Carregador de tomada turbo 30W USB-C',
    moeda: 'BRL',
  },
  {
    produto_id: 'prod_003',
    nome: 'Cabo USB',
    preco: 30.00,
    descricao: 'Cabo USB para USB-C reforçado 1m',
    moeda: 'BRL',
  },
];

