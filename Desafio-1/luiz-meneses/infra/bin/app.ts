import { App } from 'aws-cdk-lib';
import { ChatPayStack } from '../lib/stack';

const app = new App();
const prefixo = app.node.tryGetContext('prefixo') ?? 'luiz-meneses';

new ChatPayStack(app, `${prefixo}-desafio1`, {
  prefixo,
  origemFront: app.node.tryGetContext('origemFront') ?? 'http://localhost:5173',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  tags: { projeto: 'chatpay-desafio1', fellow: prefixo },
});
