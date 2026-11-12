import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export interface AgentStackProps {
  stackPrefix: string;
  toolLambdaArns: {
    listarCatalogo: string;
    registrarIntencao: string;
    realizarCompra: string;
  };
}

export class AgentStack extends Construct {
  public readonly agentFn: lambda.Function;
  public readonly agentFnArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id);

    const { stackPrefix, toolLambdaArns } = props;
    const prefix = `${stackPrefix}-`;
    const agentDir = path.join(__dirname, '..', '..', 'agent');

    this.agentFn = new lambda.Function(this, 'AgentFn', {
      functionName: `${prefix}agent`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(agentDir),
      environment: {
        TOOL_LISTAR_CATALOGO_ARN: toolLambdaArns.listarCatalogo,
        TOOL_REGISTRAR_INTENCAO_ARN: toolLambdaArns.registrarIntencao,
        TOOL_REALIZAR_COMPRA_ARN: toolLambdaArns.realizarCompra,
        BEDROCK_MODEL_ID: 'claude-3-haiku',
      },
    });

    const toolInvokePolicy = new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        toolLambdaArns.listarCatalogo,
        toolLambdaArns.registrarIntencao,
        toolLambdaArns.realizarCompra,
      ],
    });
    this.agentFn.addToRolePolicy(toolInvokePolicy);

    this.agentFnArn = this.agentFn.functionArn;
  }
}
