/**
 * Tipos do objeto global `awslambda` que o runtime Node.js do Lambda injeta
 * para response streaming (nao existe pacote oficial com esses tipos).
 */
import type { Writable } from "node:stream";

declare global {
  namespace awslambda {
    interface ResponseStream extends Writable {
      setContentType(tipo: string): void;
    }
    interface MetadadosHttp {
      statusCode?: number;
      headers?: Record<string, string>;
    }
    function streamifyResponse<E>(
      handler: (evento: E, stream: ResponseStream, contexto: unknown) => Promise<void>,
    ): (evento: E, stream: ResponseStream, contexto: unknown) => Promise<void>;
    namespace HttpResponseStream {
      /** Escreve o JSON de metadados + 8 bytes nulos que o API Gateway exige. */
      function from(stream: ResponseStream, metadados: MetadadosHttp): ResponseStream;
    }
  }
}

export {};
