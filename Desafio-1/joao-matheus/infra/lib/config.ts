export const PREFIXO = 'joao-matheus';
export const NOME_STACK = `${PREFIXO}-desafio-1`;
export const REGIAO = 'us-east-1';

/**
 * Retorna o nome de um recurso prefixado com o padrão do projeto.
 * Exemplo: nome('produtos') -> 'joao-matheus-produtos'
 */
export function nome(sufixo: string): string {
  return `${PREFIXO}-${sufixo}`;
}

