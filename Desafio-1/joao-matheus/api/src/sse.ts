/**
 * Utilitários para parsing incremental e formatação de Server-Sent Events (SSE).
 */

export type EventoSSE =
  | { tipo: 'delta'; texto: string }
  | { tipo: 'ferramenta'; nome: string }
  | { tipo: 'erro'; mensagem: string }
  | { tipo: 'fim' }
  | Record<string, any>;

/**
 * Formata um objeto de evento para a linha do protocolo SSE: "data: <json>\n\n"
 */
export function formatarSse(evento: EventoSSE): string {
  return `data: ${JSON.stringify(evento)}\n\n`;
}

/**
 * Parser incremental de fluxos SSE que lida com chunks fragmentados ou múltiplos eventos no mesmo buffer.
 */
export class SseParser {
  private buffer = '';
  private decoder = new TextDecoder('utf-8');

  /**
   * Alimenta o parser com um novo chunk (string ou Uint8Array) e extrai os eventos completos.
   */
  public alimentar(chunk: string | Uint8Array): EventoSSE[] {
    const texto = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += texto;

    const eventos: EventoSSE[] = [];
    const partes = this.buffer.split(/\r?\n\r?\n/);

    // O último elemento após o split fica no buffer (pode ser incompleto se não terminou com \n\n)
    this.buffer = partes.pop() ?? '';

    for (const parte of partes) {
      const evento = this.parsearBloco(parte);
      if (evento) {
        eventos.push(evento);
      }
    }

    return eventos;
  }

  /**
   * Processa qualquer dado restante no buffer ao término da transmissão.
   */
  public finalizar(): EventoSSE[] {
    const eventos: EventoSSE[] = [];
    if (this.buffer.trim()) {
      const evento = this.parsearBloco(this.buffer);
      if (evento) {
        eventos.push(evento);
      }
      this.buffer = '';
    }
    return eventos;
  }

  private parsearBloco(bloco: string): EventoSSE | null {
    const linhas = bloco.split(/\r?\n/);
    const dadosLinhas: string[] = [];

    for (const linha of linhas) {
      const linhaLimpa = linha.trim();
      if (linhaLimpa.startsWith('data:')) {
        dadosLinhas.push(linhaLimpa.slice(5).trimStart());
      }
    }

    if (dadosLinhas.length === 0) {
      return null;
    }

    const payload = dadosLinhas.join('\n');
    try {
      return JSON.parse(payload) as EventoSSE;
    } catch {
      // Se não for JSON estruturado válido, trata como texto de fallback
      return { tipo: 'delta', texto: payload };
    }
  }
}
