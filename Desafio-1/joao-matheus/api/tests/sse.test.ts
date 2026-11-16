import { describe, it, expect } from 'vitest';
import { SseParser, formatarSse } from '../src/sse';

describe('formatarSse', () => {
  it('formata evento de delta no protocolo SSE', () => {
    const sse = formatarSse({ tipo: 'delta', texto: 'Olá!' });
    expect(sse).toBe('data: {"tipo":"delta","texto":"Olá!"}\n\n');
  });

  it('formata evento de fim', () => {
    const sse = formatarSse({ tipo: 'fim' });
    expect(sse).toBe('data: {"tipo":"fim"}\n\n');
  });
});

describe('SseParser', () => {
  it('processa um evento completo em um único chunk', () => {
    const parser = new SseParser();
    const eventos = parser.alimentar('data: {"tipo":"delta","texto":"teste"}\n\n');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toEqual({ tipo: 'delta', texto: 'teste' });
  });

  it('processa múltiplos eventos no mesmo chunk', () => {
    const parser = new SseParser();
    const payload =
      'data: {"tipo":"delta","texto":"A"}\n\n' +
      'data: {"tipo":"ferramenta","nome":"listar_catalogo"}\n\n' +
      'data: {"tipo":"fim"}\n\n';

    const eventos = parser.alimentar(payload);
    expect(eventos).toHaveLength(3);
    expect(eventos[0]).toEqual({ tipo: 'delta', texto: 'A' });
    expect(eventos[1]).toEqual({ tipo: 'ferramenta', nome: 'listar_catalogo' });
    expect(eventos[2]).toEqual({ tipo: 'fim' });
  });

  it('lida com fragmentação no meio do JSON entre chunks', () => {
    const parser = new SseParser();
    const chunk1 = 'data: {"tipo":"delta","tex';
    const chunk2 = 'to":"fragmentado"}\n\n';

    const ev1 = parser.alimentar(chunk1);
    expect(ev1).toHaveLength(0);

    const ev2 = parser.alimentar(chunk2);
    expect(ev2).toHaveLength(1);
    expect(ev2[0]).toEqual({ tipo: 'delta', texto: 'fragmentado' });
  });

  it('lida com quebra de linha estilo Windows CRLF (\\r\\n\\r\\n)', () => {
    const parser = new SseParser();
    const payload = 'data: {"tipo":"fim"}\r\n\r\n';
    const eventos = parser.alimentar(payload);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toEqual({ tipo: 'fim' });
  });

  it('processa chunks de Uint8Array', () => {
    const parser = new SseParser();
    const uint8 = new TextEncoder().encode('data: {"tipo":"fim"}\n\n');
    const eventos = parser.alimentar(uint8);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toEqual({ tipo: 'fim' });
  });

  it('finaliza buffer restante', () => {
    const parser = new SseParser();
    parser.alimentar('data: {"tipo":"fim"}');
    const eventos = parser.finalizar();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toEqual({ tipo: 'fim' });
  });
});
