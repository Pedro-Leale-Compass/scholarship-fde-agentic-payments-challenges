/// <reference types="node" />

declare namespace awslambda {
  export namespace HttpResponseStream {
    function from(
      stream: NodeJS.WritableStream,
      metadata: {
        statusCode?: number;
        headers?: Record<string, string>;
      }
    ): NodeJS.WritableStream;
  }

  export function streamifyResponse<TEvent = any, TResult = any>(
    handler: (
      event: TEvent,
      responseStream: NodeJS.WritableStream,
      context: any
    ) => Promise<TResult>
  ): (event: TEvent, context: any) => Promise<TResult>;
}
