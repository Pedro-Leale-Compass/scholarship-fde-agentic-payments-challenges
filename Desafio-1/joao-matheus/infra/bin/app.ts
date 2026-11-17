#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DesafioStack } from '../lib/stack';
import { NOME_STACK, REGIAO } from '../lib/config';

const app = new cdk.App();

new DesafioStack(app, NOME_STACK, {
  stackName: NOME_STACK,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: REGIAO,
  },
  description: 'Stack do Desafio 1 (Sprint 2) - Agente de Pagamentos na AWS (João Matheus)',
});

cdk.Tags.of(app).add('owner', 'joao-matheus');
cdk.Tags.of(app).add('projeto', 'desafio-1');

