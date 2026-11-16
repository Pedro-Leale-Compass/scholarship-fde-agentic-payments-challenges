import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';

export interface AgenteConstructProps {
  toolListarCatalogo: lambda.IFunction;
  toolRegistrarIntencao: lambda.IFunction;
  toolRealizarCompra: lambda.IFunction;
}

export class AgenteConstruct extends Construct {
  public readonly imagem: ecr_assets.DockerImageAsset;
  public readonly role: iam.Role;
  public readonly runtime: bedrockagentcore.CfnRuntime;
  public readonly runtimeArn: string;
  public readonly runtimeId: string;
  public readonly imageUri: string;

  constructor(scope: Construct, id: string, props: AgenteConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const modelId =
      this.node.tryGetContext('modelId') ||
      'us.anthropic.claude-haiku-4-5-20251001-v1:0';

    // 1. Imagem Docker do Agente (Strands, Python 3.12, ARM64)
    this.imagem = new ecr_assets.DockerImageAsset(this, 'ImagemAgente', {
      directory: path.join(__dirname, '../../../agent'),
      platform: ecr_assets.Platform.LINUX_ARM64,
    });
    this.imageUri = this.imagem.imageUri;

    // 2. Role de execucao do Runtime com menor privilegio
    // Trust: principal bedrock-agentcore.amazonaws.com com SourceAccount e SourceArn
    this.role = new iam.Role(this, 'RoleRuntime', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:*`,
          },
        },
      }),
      description: 'Role de execucao do AgentCore Runtime com menor privilegio',
    });

    // Permissoes ECR: pull da imagem do repositorio de assets do CDK
    this.imagem.repository.grantPull(this.role);

    // ecr:GetAuthorizationToken nao suporta restricao de recurso (exige Resource: *)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirEcrAuthToken',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );

    // Permissoes Bedrock: invocacao com streaming do Claude Haiku 4.5
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirInvokeModelBedrock',
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        resources: [
          `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
        ],
      })
    );

    // Permissoes CloudWatch Logs: restrito ao log group de runtimes AgentCore
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirLogsRuntime',
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
        ],
        resources: [
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
        ],
      })
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirDescribeLogGroups',
        actions: ['logs:DescribeLogGroups'],
        resources: [
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:*`,
        ],
      })
    );

    // Permissoes CloudWatch Metrics: namespace restrito a bedrock-agentcore
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirCloudWatchMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'bedrock-agentcore',
          },
        },
      })
    );

    // Permissoes Lambda: apenas nas 3 tools
    props.toolListarCatalogo.grantInvoke(this.role);
    props.toolRegistrarIntencao.grantInvoke(this.role);
    props.toolRealizarCompra.grantInvoke(this.role);

    // 3. Bedrock AgentCore Runtime
    // Identificador sem hifens: joao_matheus_agente_pagamentos
    this.runtime = new bedrockagentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: 'joao_matheus_agente_pagamentos',
      description: 'Agente de pagamentos (Strands + Claude Haiku 4.5) - Joao Matheus',
      roleArn: this.role.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: this.imagem.imageUri,
        },
      },
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      protocolConfiguration: 'HTTP',
      environmentVariables: {
        MODEL_ID: modelId,
        TOOL_LISTAR_CATALOGO_ARN: props.toolListarCatalogo.functionArn,
        TOOL_REGISTRAR_INTENCAO_ARN: props.toolRegistrarIntencao.functionArn,
        TOOL_REALIZAR_COMPRA_ARN: props.toolRealizarCompra.functionArn,
      },
    });

    // Garante criacao da role e policies antes da submissao do runtime
    this.runtime.node.addDependency(this.role);

    this.runtimeArn = this.runtime.attrAgentRuntimeArn;
    this.runtimeId = this.runtime.attrAgentRuntimeId;
  }
}
