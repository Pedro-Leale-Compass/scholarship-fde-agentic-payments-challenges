import { describe, it, expect } from 'vitest';
import { sanitizarHistorico, MensagemHistorico } from '../src/historico';

describe('sanitizarHistorico', () => {
  it('mantém mensagens intactas quando já inicia por user', () => {
    const mensagens: MensagemHistorico[] = [
      { role: 'user', texto: 'olá' },
      { role: 'assistant', texto: 'olá, como posso ajudar?' },
    ];
    const resultado = sanitizarHistorico(mensagens);
    expect(resultado).toEqual(mensagens);
  });

  it('descarta mensagens do assistente antes do primeiro turno de usuário', () => {
    const mensagens: MensagemHistorico[] = [
      { role: 'assistant', texto: 'mensagem solta de assistente' },
      { role: 'assistant', texto: 'outra mensagem solta' },
      { role: 'user', texto: 'primeira mensagem do usuário' },
      { role: 'assistant', texto: 'resposta' },
    ];
    const resultado = sanitizarHistorico(mensagens);
    expect(resultado).toHaveLength(2);
    expect(resultado[0].role).toBe('user');
    expect(resultado[0].texto).toBe('primeira mensagem do usuário');
  });

  it('retorna array vazio se não houver nenhuma mensagem de user', () => {
    const mensagens: MensagemHistorico[] = [
      { role: 'assistant', texto: 'apenas assistente' },
    ];
    const resultado = sanitizarHistorico(mensagens);
    expect(resultado).toEqual([]);
  });

  it('lida com lista vazia', () => {
    expect(sanitizarHistorico([])).toEqual([]);
  });
});
