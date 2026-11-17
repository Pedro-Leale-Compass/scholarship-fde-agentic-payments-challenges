#!/usr/bin/env node
/**
 * Script de destruição completa e segura da infraestrutura do Desafio 1.
 *
 * Além de executar o 'cdk destroy', este script limpa os recursos que
 * sobrevivem ao destroy por ficarem fora do ciclo de vida da stack:
 * 1. A imagem Docker específica do agente no repositório ECR do bootstrap;
 * 2. Log groups residuais do Bedrock AgentCore Runtime e Lambdas auxiliares.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STACK_NAME = 'joao-matheus-desafio-1';
const REGION = process.env.AWS_REGION || 'us-east-1';
const PROFILE = process.env.AWS_PROFILE || 'joao_fellowship';

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f') || args.includes('-y');

// 1. Resgatar identificadores da stack antes da destruição
let agentImageUri = null;
let agentRuntimeId = null;
let bucketName = null;

const outputsPath = path.resolve(__dirname, '../cdk-outputs.json');
if (fs.existsSync(outputsPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(outputsPath, 'utf8'));
    const outputs = raw[STACK_NAME] || raw;
    agentImageUri = outputs.AgentImageUri;
    agentRuntimeId = outputs.AgentRuntimeId;
    bucketName = outputs.BucketName;
  } catch {
    // fallback via aws cli
  }
}

if (!agentImageUri || !agentRuntimeId) {
  try {
    const cfnOut = execFileSync(
      'aws',
      [
        'cloudformation',
        'describe-stacks',
        '--stack-name',
        STACK_NAME,
        '--region',
        REGION,
        '--profile',
        PROFILE,
        '--output',
        'json',
      ],
      { encoding: 'utf8' }
    );
    const cfnData = JSON.parse(cfnOut);
    const outputs = cfnData.Stacks?.[0]?.Outputs || [];
    for (const o of outputs) {
      if (o.OutputKey === 'AgentImageUri') agentImageUri = o.OutputValue;
      if (o.OutputKey === 'AgentRuntimeId') agentRuntimeId = o.OutputValue;
      if (o.OutputKey === 'BucketName') bucketName = o.OutputValue;
    }
  } catch (err) {
    console.warn('[aviso] Não foi possível ler outputs da stack via CloudFormation:', err.message);
  }
}

console.log('========================================================');
console.log(`  Destruição da Stack: ${STACK_NAME}`);
console.log('========================================================');
console.log(`Região: ${REGION}`);
console.log(`Perfil: ${PROFILE}`);
if (agentRuntimeId) console.log(`AgentRuntimeId: ${agentRuntimeId}`);
if (agentImageUri) console.log(`AgentImageUri: ${agentImageUri}`);
if (bucketName) console.log(`BucketName: ${bucketName}`);
console.log('--------------------------------------------------------');

async function confirmar(): Promise<boolean> {
  if (force) return true;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      `⚠️ Tem certeza de que deseja destruir todos os recursos da stack ${STACK_NAME}? (digite '${STACK_NAME}' para confirmar): `,
      (resposta) => {
        rl.close();
        resolve(resposta.trim() === STACK_NAME || resposta.trim().toLowerCase() === 'sim');
      }
    );
  });
}

async function executar() {
  const confirmado = await confirmar();
  if (!confirmado) {
    console.log('Operação cancelada pelo usuário.');
    process.exit(0);
  }

  // 2. Executar cdk destroy
  console.log('\n[1/3] Executando cdk destroy...');
  const cdkResult = spawnSync('npx', ['cdk', 'destroy', '--force'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, AWS_PROFILE: PROFILE, AWS_REGION: REGION },
    shell: true,
  });

  if (cdkResult.status !== 0) {
    console.error('Falha na execução do cdk destroy.');
  } else {
    console.log('✅ Stack CloudFormation removida com sucesso!');
  }

  // 3. Remover imagem do agente no ECR (apenas a tag específica da stack)
  console.log('\n[2/3] Limpando imagem Docker no ECR do bootstrap...');
  if (agentImageUri && agentImageUri.includes(':')) {
    try {
      const parts = agentImageUri.split('/');
      const repoAndTag = parts.slice(1).join('/');
      const [repoName, imageTag] = repoAndTag.split(':');

      console.log(`Removendo imagem ${imageTag} do repositório ${repoName}...`);
      execFileSync(
        'aws',
        [
          'ecr',
          'batch-delete-image',
          '--repository-name',
          repoName,
          '--image-ids',
          `imageTag=${imageTag}`,
          '--region',
          REGION,
          '--profile',
          PROFILE,
        ],
        { stdio: 'inherit' }
      );
      console.log('✅ Imagem do agente removida do ECR.');
    } catch (err) {
      console.warn('[aviso] Não foi possível remover a imagem do ECR:', err.message);
    }
  } else {
    console.log('Nenhuma imagem do ECR para remover.');
  }

  // 4. Limpar log groups com o prefixo joao-matheus
  console.log('\n[3/3] Verificando e removendo log groups residuais...');
  try {
    const logsOut = execFileSync(
      'aws',
      [
        'logs',
        'describe-log-groups',
        '--log-group-name-prefix',
        '/aws/bedrock-agentcore/runtimes/',
        '--region',
        REGION,
        '--profile',
        PROFILE,
        '--query',
        'logGroups[].logGroupName',
        '--output',
        'json',
      ],
      { encoding: 'utf8' }
    );

    const logGroups = JSON.parse(logsOut) || [];
    for (const lg of logGroups) {
      if (agentRuntimeId && lg.includes(agentRuntimeId)) {
        console.log(`Apagando log group residual: ${lg}`);
        execFileSync(
          'aws',
          ['logs', 'delete-log-group', '--log-group-name', lg, '--region', REGION, '--profile', PROFILE],
          { stdio: 'inherit' }
        );
      }
    }
  } catch (err) {
    console.warn('[aviso] Não foi possível limpar log groups do AgentCore:', err.message);
  }

  console.log('\n========================================================');
  console.log('  Teardown concluído!');
  console.log('========================================================');
}

executar().catch((err) => {
  console.error('Erro durante o teardown:', err);
  process.exit(1);
});
