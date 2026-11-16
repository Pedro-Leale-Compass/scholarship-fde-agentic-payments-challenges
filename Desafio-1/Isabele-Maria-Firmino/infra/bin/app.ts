import * as cdk from 'aws-cdk-lib'
import { DesafioStack } from '../lib/stack.ts'

function parseFrontend(valor: unknown): boolean {
  return valor !== false && valor !== 'false'
}

const app = new cdk.App()

new DesafioStack(app, 'DesafioStack', {
  stackName: 'isabele-desafio-1',
  prefixo: 'isabele',
  frontend: parseFrontend(app.node.tryGetContext('frontend')),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Desafio Sprint 2 - agente de pagamentos na AWS (Isabele)',
})

cdk.Tags.of(app).add('projeto', 'desafio-1-sprint-2')
cdk.Tags.of(app).add('responsavel', 'isabele')
