#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
let usuarioId = null;
let prompt = null;
let historicoJson = null;
let runtimeArn = null;
let region = process.env.AWS_REGION || 'us-east-1';
let rawOutput = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--usuario' && args[i + 1]) {
    usuarioId = args[i + 1];
    i++;
  } else if (args[i] === '--prompt' && args[i + 1]) {
    prompt = args[i + 1];
    i++;
  } else if (args[i] === '--historico' && args[i + 1]) {
    historicoJson = args[i + 1];
    i++;
  } else if (args[i] === '--runtime-arn' && args[i + 1]) {
    runtimeArn = args[i + 1];
    i++;
  } else if (args[i] === '--region' && args[i + 1]) {
    region = args[i + 1];
    i++;
  } else if (args[i] === '--raw') {
    rawOutput = true;
  }
}

if (!usuarioId || !prompt) {
  console.error(
    'Uso: node scripts/invocar-agente.mjs --usuario <id> --prompt "<texto>" [--historico \'<json>\'] [--runtime-arn <arn>]'
  );
  process.exit(1);
}

// 1. Obter AgentRuntimeArn do cdk-outputs.json se não passado via flag
if (!runtimeArn) {
  const outputsPath = path.resolve(__dirname, '../cdk-outputs.json');
  if (fs.existsSync(outputsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(outputsPath, 'utf8'));
      const stackOutputs = raw['joao-matheus-desafio-1'] || raw;
      runtimeArn = stackOutputs.AgentRuntimeArn;
    } catch (e) {
      console.warn(`[aviso] Falha ao ler cdk-outputs.json: ${e.message}`);
    }
  }
}

if (!runtimeArn) {
  console.error(
    'Erro: AgentRuntimeArn não encontrado. Execute o deploy primeiro ou passe --runtime-arn <arn>.'
  );
  process.exit(1);
}

// 2. Parse do histórico se fornecido (como JSON string ou caminho para arquivo .json)
let historico = [];
if (historicoJson) {
  try {
    if (fs.existsSync(historicoJson)) {
      historico = JSON.parse(fs.readFileSync(historicoJson, 'utf8'));
    } else {
      historico = JSON.parse(historicoJson);
    }
  } catch (e) {
    console.error(`Erro ao parsear --historico: ${e.message}`);
    process.exit(1);
  }
}

// 3. Montar sessão (mínimo 33 caracteres exigido pela API)
const sessionIdSuffix = crypto.randomBytes(12).toString('hex');
const runtimeSessionId = `sessao-${usuarioId.slice(0, 10)}-${Date.now()}-${sessionIdSuffix}`.padEnd(36, '0');

console.log(`[agente] Invocando runtime: ${runtimeArn}`);
console.log(`[agente] Usuário: ${usuarioId}`);
console.log(`[agente] Sessão: ${runtimeSessionId}`);
console.log(`[agente] Prompt: "${prompt}"\n---`);

const client = new BedrockAgentCoreClient({
  region,
});

const payload = {
  usuario_id: usuarioId,
  prompt,
  historico,
};

async function executar() {
  try {
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId,
      contentType: 'application/json',
      accept: 'text/event-stream',
      payload: Buffer.from(JSON.stringify(payload)),
    });

    const response = await client.send(command);

    if (!response.response) {
      console.error('Resposta vazia do runtime.');
      return;
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for await (const chunk of response.response) {
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (rawOutput) {
        process.stdout.write(text);
        continue;
      }

      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        try {
          const ev = JSON.parse(dataStr);
          if (ev.tipo === 'delta' && ev.texto) {
            process.stdout.write(ev.texto);
          } else if (ev.tipo === 'ferramenta' && ev.nome) {
            process.stdout.write(`\n\x1b[36m[Executando tool: ${ev.nome}]\x1b[0m\n`);
          } else if (ev.tipo === 'erro' && ev.mensagem) {
            process.stderr.write(`\n\x1b[31m[Erro]: ${ev.mensagem}\x1b[0m\n`);
          } else if (ev.tipo === 'fim') {
            process.stdout.write('\n---\n[Fim da resposta]\n');
          }
        } catch {
          // Linha parcial ou não-JSON
        }
      }
    }
  } catch (err) {
    console.error(`\n[Erro na invocação]:`, err.message || err);
    process.exit(1);
  }
}

executar();
