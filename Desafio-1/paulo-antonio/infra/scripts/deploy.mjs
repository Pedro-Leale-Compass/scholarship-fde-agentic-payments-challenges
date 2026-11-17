import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const infra = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(infra, '..');
const args = process.argv.slice(2).filter(value => value !== '--');
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--account', '--profile', '--prefix', '--mode'].includes(args[i]) || !args[i + 1]) {
    throw new Error('Uso: pnpm run deploy --account CONTA --profile desafio-1 --prefix paulo-antonio');
  }
  options[args[i].slice(2)] = args[i + 1];
}
const account = options.account;
const backendOnly = options.mode === 'backend';
if (options.mode && !['backend', 'full'].includes(options.mode)) throw new Error('Modo inválido. Use backend ou full.');
const profile = options.profile ?? 'desafio-1';
const prefix = options.prefix ?? 'paulo-antonio';
if (!/^\d{12}$/.test(account ?? '')) throw new Error('Informe explicitamente --account com a conta esperada (12 dígitos).');
if (!/^[a-z][a-z0-9-]{2,24}$/.test(prefix)) throw new Error('Prefixo inválido.');
if (!profile || profile.startsWith('-')) throw new Error('Perfil inválido.');
const pnpm = process.env.npm_execpath;
if (!pnpm || !/pnpm/i.test(pnpm)) throw new Error('Execute este script por pnpm run deploy.');

function run(command, args, cwd = infra, capture = false) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', shell: false,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, AWS_PROFILE: profile, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', AWS_PAGER: '', NEXT_TELEMETRY_DISABLED: '1' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Falha em ${command}: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout;
}
function aws(args, capture = false) {
  return run('aws', [...args, '--profile', profile, '--region', 'us-east-1', '--no-cli-pager'], infra, capture);
}
function pkg(args, cwd = infra) { return run(process.execPath, [pnpm, ...args], cwd); }

const identity = JSON.parse(aws(['sts', 'get-caller-identity', '--output', 'json'], true));
if (identity.Account !== account || !identity.Arn.includes('assumed-role/AWSReservedSSO_')) {
  throw new Error('A identidade não corresponde à conta SSO esperada. Nenhum recurso foi criado.');
}
console.log(`Conta SSO conferida. Região us-east-1. Stack ${prefix}-pagamentos.`);
console.log('Este deploy cria recursos AWS. O CDK mostrará alterações de permissões para revisão.');
pkg(['install', '--frozen-lockfile', '--store-dir', resolve(project, '.pnpm-store')], resolve(project, 'frontend'));
pkg(['run', 'build'], resolve(project, 'frontend'));
pkg(['install', '--frozen-lockfile', '--store-dir', resolve(project, '.pnpm-store')], resolve(project, 'tools'));
pkg(['install', '--frozen-lockfile', '--store-dir', resolve(project, '.pnpm-store')], resolve(project, 'agent'));
pkg(['run', 'build']);

const outputDir = resolve(project, '.deploy');
mkdirSync(outputDir, { recursive: true });
const outputFile = resolve(outputDir, 'outputs.json');
// Minimal preparation via IaC, using SSO directly rather than admin bootstrap roles.
aws(['cloudformation', 'deploy', '--template-file', resolve(infra, 'deployment-assets.json'),
  '--stack-name', `${prefix}-assets`, '--parameter-overrides', `Prefix=${prefix}`,
  '--no-fail-on-empty-changeset']);
pkg(['exec', 'cdk', 'deploy', `${prefix}-pagamentos-dados`, '--profile', profile,
  '--context', `prefix=${prefix}`, '--context', `backendOnly=${backendOnly}`,
  '--outputs-file', resolve(outputDir, 'data-outputs.json'), '--require-approval', 'broadening']);
pkg(['exec', 'cdk', 'deploy', `${prefix}-pagamentos`, '--profile', profile,
  '--context', `prefix=${prefix}`, '--context', `backendOnly=${backendOnly}`, '--outputs-file', outputFile, '--require-approval', 'broadening']);

const outputs = JSON.parse(readFileSync(outputFile, 'utf8'))[`${prefix}-pagamentos`];
if (outputs?.AgentRuntimeArn) {
  const runtimeId = outputs.AgentRuntimeArn.split('/').at(-1);
  aws(['logs', 'put-retention-policy', '--log-group-name', `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`, '--retention-in-days', '7']);
}
const expectedBucket = `${prefix}-pagamentos-${account}-us-east-1`;
if (!outputs || (!backendOnly && outputs.FrontendBucketName !== expectedBucket) || outputs.Region !== 'us-east-1') {
  throw new Error('Outputs inesperados. Upload interrompido; confira a stack antes de continuar.');
}
const configPath = resolve(outputDir, 'config.json');
writeFileSync(configPath, JSON.stringify({
  apiUrl: outputs.ApiUrl, region: outputs.Region,
  userPoolId: outputs.UserPoolId, userPoolClientId: outputs.UserPoolClientId,
}, null, 2));

if (backendOnly) {
  console.log('Backend publicado. Interface local: http://127.0.0.1:4173');
  console.log('Inicie frontend/scripts/preview-local.mjs --aws para usar Cognito e API reais.');
  process.exit(0);
}

aws(['s3', 'sync', resolve(project, 'frontend/out'), `s3://${expectedBucket}/`,
  '--exclude', 'config.json', '--cache-control', 'no-cache']);
aws(['s3', 'cp', configPath, `s3://${expectedBucket}/config.json`,
  '--content-type', 'application/json', '--cache-control', 'no-store']);
const invalidation = JSON.parse(aws(['cloudfront', 'create-invalidation',
  '--distribution-id', outputs.DistributionId, '--paths', '/*', '--output', 'json'], true));
aws(['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', outputs.DistributionId,
  '--id', invalidation.Invalidation.Id]);
console.log(`Interface publicada: ${outputs.FrontendUrl}`);
console.log('Próximos passos: criar usuário por convite e executar os testes descritos em infra/README.md.');
