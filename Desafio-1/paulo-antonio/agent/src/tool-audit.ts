import { randomUUID } from 'node:crypto';
import type { Dependencies } from './engine.ts';

const operations: Record<string, string> = {
  'GET /catalogo': 'listar_catalogo',
  'GET /conta': 'consultar_limite',
  'GET /intencoes/{id}': 'consultar_intencao',
  'POST /intencoes': 'registrar_intencao',
  'POST /compras': 'realizar_compra',
};

// Never log arguments, identities, model text, response bodies or exception messages.
export function auditTools(dependencies: Dependencies, log: (line: string) => void = console.log): Dependencies {
  const invocationId = randomUUID();
  return { ...dependencies, async invoke(...args) {
    const callId = randomUUID();
    const operation = operations[`${args[1]} ${args[2]}`] ?? 'unknown';
    const started = Date.now();
    const record = (event: string, result?: string) => log(JSON.stringify({
      event, invocationId, callId, operation, ...(result ? { result, durationMs: Date.now() - started } : {}),
    }));
    record('tool_call_started');
    try {
      const value = await dependencies.invoke(...args);
      record('tool_call_finished', value?.erro ? 'refused' : 'success');
      return value;
    } catch (error) {
      record('tool_call_finished', 'error');
      throw error;
    }
  } };
}
