import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class DesafioStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // Stack do Desafio 1 (Sprint 2) - Agente de Pagamentos na AWS
    //
    // Esta stack será populada ao longo das seguintes fases:
    // - Fase 01 (Fundação): Tabelas DynamoDB (5) + Seed de produtos,
    //                       Cognito User Pool & Client,
    //                       S3 privado + CloudFront (OAC) para o frontend.
    // - Fase 02 (Tools): 3 Lambdas Python das ferramentas de pagamento + IAM.
    // - Fase 03 (Agente): Strands Agent no Bedrock AgentCore Runtime + Role IAM.
    // - Fase 04 (API): API Gateway REST (streaming) + Cognito Authorizer +
    //                  Lambdas chat e conversas (Node.js 22 / TS) + CORS.
    // - Fase 05 (Frontend): BucketDeployment do SPA React + config.json gerado.
    // - Fase 06 (Entrega): Revisão final de IAM, scripts de destroy e evidências.
    // =========================================================================
  }
}

