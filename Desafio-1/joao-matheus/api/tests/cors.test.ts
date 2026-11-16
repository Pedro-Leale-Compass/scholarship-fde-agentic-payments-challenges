import { describe, it, expect, beforeEach } from 'vitest';
import { obterOrigemPermitida, cabecalhosCors } from '../src/cors';

describe('CORS utilitários', () => {
  beforeEach(() => {
    process.env.ORIGENS_PERMITIDAS = 'https://d1234.cloudfront.net,http://localhost:5173';
  });

  it('permite origem exata do CloudFront', () => {
    const origem = obterOrigemPermitida({
      headers: { origin: 'https://d1234.cloudfront.net' },
    });
    expect(origem).toBe('https://d1234.cloudfront.net');
  });

  it('permite localhost quando configurado', () => {
    const origem = obterOrigemPermitida({
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(origem).toBe('http://localhost:5173');
  });

  it('retorna a origem padrão segura para origens não autorizadas', () => {
    const origem = obterOrigemPermitida({
      headers: { origin: 'https://malicioso.example.com' },
    });
    expect(origem).toBe('https://d1234.cloudfront.net');
  });

  it('monta cabecalhos CORS completos', () => {
    const headers = cabecalhosCors({
      headers: { origin: 'http://localhost:5173' },
    });
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(headers['Access-Control-Allow-Methods']).toContain('POST');
    expect(headers['Vary']).toBe('Origin');
  });
});
