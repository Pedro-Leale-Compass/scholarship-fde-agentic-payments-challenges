> **HISTÓRICO — arquivado em 2026-11-17.** Este documento descreve um estado antigo ou um plano concluído. Não use como fonte de verdade. Consulte `docs/README.md` e o código atual.

# Agent 500 Error — Root Cause Analysis

## Symptom

Web UI calls `POST /chat` and receives:

```json
{
  "error": "agent_error",
  "message": "Received error (500) from runtime. Please check your CloudWatch logs for more information."
}
```

## Root Cause

### Primary: Fastify serialization error in AgentCore Runtime

The AgentCore runtime container logs (`/aws/bedrock-agentcore/runtimes/<agent-runtime-id>-DEFAULT`) show:

```
FastifyError: Attempted to send payload of invalid type 'object'. Expected a string or Buffer.
    at onSendEnd (/app/node_modules/fastify/lib/reply.js:695:11)
```

The agent's `invocationHandler.process()` in `agent/index.ts:232-237` returns a plain JavaScript object:

```ts
return {
  ok: true,
  usuario_id,
  reply: chunks.join('').trim() || 'Não foi possível gerar uma resposta.',
  model: MODEL_ID,
};
```

The `bedrock-agentcore` runtime (Fastify-based) cannot serialize this object directly as an HTTP response body — it expects a `string` or `Buffer`. The SDK version (`bedrock-agentcore@^0.4.0`) apparently changed how it handles handler return values, exposing this latent bug.

### Secondary: Blank prompt (my CLI test artifact)

When I invoked the Lambda directly via AWS CLI, I passed the payload as the event object itself rather than as `event.body` (a JSON string). This made `event.body` an object instead of a string, causing `JSON.parse()` to fall into the catch block, leaving `messages = []` and `prompt = ""`. The strands SDK then rejected it with "Input prompt is blank."

This is NOT the production issue — API Gateway sends `event.body` as a JSON string, which the Lambda handles correctly.

## What Changed Since It Last Worked

No code change in `agent/index.ts` or `api/index.ts` between the last working state and now would cause this. The `invocationHandler.process()` return value and the Lambda prompt construction are identical to commit `adb4d83` (Nov 15).

The issue was latent — the `FastifyError: object` error existed but may have been masked by a different `bedrock-agentcore` SDK version or runtime configuration. It surfaced now after the stack was redeployed with the current SDK version.

## Fix

Change `agent/index.ts:232-237` to return a JSON string instead of a plain object:

```ts
return JSON.stringify({
  ok: true,
  usuario_id,
  reply: chunks.join('').trim() || 'Não foi possível gerar uma resposta.',
  model: MODEL_ID,
});
```

## Verification Steps

1. Apply the fix above to `agent/index.ts`
2. Build: `npm run build` (in `infra/`)
3. Deploy: `npm run deploy`
4. Test via web UI or Postman with valid Cognito token
5. Confirm CloudWatch logs no longer show `FastifyError: object`

## Files Affected

- `Desafio-1/luiz-henrique/agent/index.ts` — the `process` handler return value (lines 232-237)

## Safety

No other files need changes. The IAM role fix (`bedrock-runtime:*` instead of `bedrock:*`) is already deployed and confirmed in the role policy. The runtime is `READY` with `BEDROCK_MODEL_ID=global.amazon.nova-2-lite-v1:0`.