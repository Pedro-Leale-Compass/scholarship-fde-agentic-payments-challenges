import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface PaymentAgentProps {
  /**
   * Prefixo obrigatório para isolamento na conta compartilhada (ex: 'alvaro-').
   */
  readonly resourcePrefix: string;
  readonly consultarSaldoLambda: lambda.IFunction;
  readonly criarIntencaoLambda: lambda.IFunction;
  readonly confirmarPagamentoLambda: lambda.IFunction;
}

const BEDROCK_MODEL_ID = 'us.anthropic.claude-3-haiku-20240307-v1:0';
const BEDROCK_FOUNDATION_MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

/**
 * Construto do Amazon Bedrock AgentCore Runtime para o assistente da Nexus Store.
 *
 * Responsabilidades:
 * 1. Empacotar o serviço Strands Agent (@strands-agents/sdk + Express porta 8080) como imagem ARM64.
 * 2. Provisionar o AgentCore Runtime com role dedicada de menor privilégio:
 *    - bedrock:InvokeModel / InvokeModelWithResponseStream estritamente para Claude 3 Haiku;
 *    - lambda:InvokeFunction apenas nas 3 Tool Lambdas determinísticas;
 *    - ZERO permissões diretas sobre tabelas DynamoDB.
 */
export class PaymentAgent extends Construct {
  public readonly runtime: bedrockagentcore.Runtime;

  constructor(scope: Construct, id: string, props: PaymentAgentProps) {
    super(scope, id);

    // AgentCore RuntimeName aceita apenas [a-zA-Z][a-zA-Z0-9_]{0,47} (sem hífen)
    const normalizedPrefix = props.resourcePrefix.replace(/[^a-zA-Z0-9_]/g, '_');
    const runtimeName = `${normalizedPrefix}payment_agent`;

    // AgentCore Runtime opera em infraestrutura AWS Graviton (linux/arm64)
    const agentRuntimeArtifact = bedrockagentcore.AgentRuntimeArtifact.fromAsset(
      path.resolve(__dirname, '../../agent'),
      {
        platform: ecrAssets.Platform.LINUX_ARM64,
      },
    );

    this.runtime = new bedrockagentcore.Runtime(this, 'Runtime', {
      runtimeName,
      description: 'Assistente conversacional Strands (Nexus Store) no Bedrock AgentCore Runtime',
      agentRuntimeArtifact,
      environmentVariables: {
        BEDROCK_MODEL_ID: BEDROCK_MODEL_ID,
        TOOL_CONSULTAR_SALDO_FUNCTION_NAME: props.consultarSaldoLambda.functionName,
        TOOL_CRIAR_INTENCAO_FUNCTION_NAME: props.criarIntencaoLambda.functionName,
        TOOL_CONFIRMAR_PAGAMENTO_FUNCTION_NAME: props.confirmarPagamentoLambda.functionName,
        TOOL_CONSULTAR_SALDO_ARN: props.consultarSaldoLambda.functionArn,
        TOOL_CRIAR_INTENCAO_ARN: props.criarIntencaoLambda.functionArn,
        TOOL_CONFIRMAR_PAGAMENTO_ARN: props.confirmarPagamentoLambda.functionArn,
      },
    });

    // Menor privilégio no Bedrock: apenas InvokeModel e InvokeModelWithResponseStream no Claude Haiku
    this.runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeClaudeHaikuBedrockModel',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${BEDROCK_MODEL_ID}`,
          `arn:${cdk.Aws.PARTITION}:bedrock:us-east-1::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
          `arn:${cdk.Aws.PARTITION}:bedrock:us-east-2::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
          `arn:${cdk.Aws.PARTITION}:bedrock:us-west-2::foundation-model/${BEDROCK_FOUNDATION_MODEL_ID}`,
        ],
      }),
    );

    // O runtime só aciona as ferramentas determinísticas; acesso ao DynamoDB pertence exclusivamente às Lambdas.
    props.consultarSaldoLambda.grantInvoke(this.runtime.grantPrincipal);
    props.criarIntencaoLambda.grantInvoke(this.runtime.grantPrincipal);
    props.confirmarPagamentoLambda.grantInvoke(this.runtime.grantPrincipal);

    new cdk.CfnOutput(this, 'AgentRuntimeArnOutput', {
      value: this.runtime.agentRuntimeArn,
      description: 'ARN do Amazon Bedrock AgentCore Runtime da Nexus Store',
      exportName: `${props.resourcePrefix}agent-runtime-arn`,
    });

    new cdk.CfnOutput(this, 'AgentRuntimeIdOutput', {
      value: this.runtime.agentRuntimeId,
      description: 'ID do Amazon Bedrock AgentCore Runtime da Nexus Store',
      exportName: `${props.resourcePrefix}agent-runtime-id`,
    });
  }
}
