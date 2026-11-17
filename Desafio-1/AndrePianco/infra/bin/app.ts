#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BackendStack } from "../lib/backend-stack";

const app = new cdk.App();

// Regra do desafio: TODOS os recursos em us-east-1.
new BackendStack(app, "AgentePagamentosBackend", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  description: "Desafio 1 - Agente de Pagamentos na AWS (backend)",
});

cdk.Tags.of(app).add("projeto", "agente-pagamentos");
