import { App } from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { deploymentSynthesizer } from '../lib/deployment-synthesizer';
import { PaymentDataStack } from '../lib/payment-data-stack';

const app = new App();
const prefix = app.node.tryGetContext('prefix') ?? 'paulo-antonio';
if (typeof prefix !== 'string' || !/^[a-z][a-z0-9-]{2,24}$/.test(prefix)) {
  throw new Error('Prefixo deve ter de 3 a 25 caracteres: letras minúsculas, números e hífen.');
}
new FoundationStack(app, `${prefix}-pagamentos`, {
  prefix,
  backendOnly: app.node.tryGetContext('backendOnly') === 'true',
  synthesizer: deploymentSynthesizer(prefix),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Desafio 1 - etapa inicial: frontend, Cognito e API de sessão',
});
new PaymentDataStack(app, `${prefix}-pagamentos-dados`, {
  prefix, synthesizer: deploymentSynthesizer(prefix),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Desafio 1 - usuarios, intencoes e transacoes simuladas',
});
