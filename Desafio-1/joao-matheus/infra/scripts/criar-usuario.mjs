#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
let email = null;
let limite = '500';
let profile = process.env.AWS_PROFILE || 'joao_fellowship';
let region = process.env.AWS_REGION || 'us-east-1';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--email' && args[i + 1]) {
    email = args[i + 1];
    i++;
  } else if (args[i] === '--limite' && args[i + 1]) {
    limite = args[i + 1];
    i++;
  } else if (args[i] === '--profile' && args[i + 1]) {
    profile = args[i + 1];
    i++;
  } else if (args[i] === '--region' && args[i + 1]) {
    region = args[i + 1];
    i++;
  }
}

if (!email) {
  console.error('Uso: node scripts/criar-usuario.mjs --email <email> [--limite <valor>] [--profile <profile>]');
  process.exit(1);
}

const limiteNum = parseFloat(limite);
if (isNaN(limiteNum) || limiteNum <= 0) {
  console.error(`Limite inválido: ${limite}. Deve ser um número positivo.`);
  process.exit(1);
}

// 1. Obter UserPoolId e UsuariosTableName
let userPoolId = null;
let usuariosTable = null;

const outputsPath = path.resolve(__dirname, '../cdk-outputs.json');
if (fs.existsSync(outputsPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(outputsPath, 'utf8'));
    const stackOutputs = raw['joao-matheus-desafio-1'] || Object.values(raw)[0] || {};
    userPoolId = stackOutputs.UserPoolId;
    usuariosTable = stackOutputs.UsuariosTableName;
  } catch (err) {
    // fallback via aws cli
  }
}

if (!userPoolId || !usuariosTable) {
  console.log('Buscando outputs da stack joao-matheus-desafio-1 via CloudFormation...');
  const cfnOut = execFileSync(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      'joao-matheus-desafio-1',
      '--region',
      region,
      '--profile',
      profile,
      '--output',
      'json',
    ],
    { encoding: 'utf8' }
  );
  const cfnData = JSON.parse(cfnOut);
  const outputs = cfnData.Stacks?.[0]?.Outputs || [];
  for (const o of outputs) {
    if (o.OutputKey === 'UserPoolId') userPoolId = o.OutputValue;
    if (o.OutputKey === 'UsuariosTableName') usuariosTable = o.OutputValue;
  }
}

if (!userPoolId || !usuariosTable) {
  console.error('Não foi possível encontrar UserPoolId ou UsuariosTableName nos outputs da stack.');
  process.exit(1);
}

console.log(`Criando usuário no Cognito User Pool (${userPoolId})...`);
// 2. admin-create-user
const cognitoOut = execFileSync(
  'aws',
  [
    'cognito-idp',
    'admin-create-user',
    '--user-pool-id',
    userPoolId,
    '--username',
    email,
    '--user-attributes',
    'Name=email,Value=' + email,
    'Name=email_verified,Value=true',
    '--desired-delivery-mediums',
    'EMAIL',
    '--region',
    region,
    '--profile',
    profile,
    '--output',
    'json',
  ],
  { encoding: 'utf8' }
);

const cognitoUser = JSON.parse(cognitoOut).User;
const subAttr = cognitoUser.Attributes?.find((a) => a.Name === 'sub');
if (!subAttr || !subAttr.Value) {
  console.error('Atributo sub não encontrado no usuário criado.');
  process.exit(1);
}
const usuarioId = subAttr.Value;
console.log(`Usuário criado no Cognito! sub (usuario_id): ${usuarioId}`);

// 3. PutItem em usuarios
console.log(`Cadastrando limite de ${limiteNum.toFixed(2)} na tabela ${usuariosTable}...`);
const agora = new Date().toISOString();
const itemDdb = {
  usuario_id: { S: usuarioId },
  email: { S: email },
  limite: { N: limiteNum.toFixed(2) },
  limite_restante: { N: limiteNum.toFixed(2) },
  criado_em: { S: agora },
};

execFileSync(
  'aws',
  [
    'dynamodb',
    'put-item',
    '--table-name',
    usuariosTable,
    '--item',
    JSON.stringify(itemDdb),
    '--region',
    region,
    '--profile',
    profile,
  ],
  { encoding: 'utf8' }
);

console.log(`✅ Sucesso! Usuário criado:`);
console.log(`- Email: ${email}`);
console.log(`- usuario_id (sub): ${usuarioId}`);
console.log(`- Limite inicial e restante: R$ ${limiteNum.toFixed(2)}`);
console.log(`- Convite com senha temporária enviado por e-mail pelo Cognito.`);
