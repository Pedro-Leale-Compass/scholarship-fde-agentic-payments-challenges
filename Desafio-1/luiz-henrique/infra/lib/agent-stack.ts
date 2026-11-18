import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { optionalEnv } from './env';

const DEFAULT_MODEL_ID = 'global.amazon.nova-2-lite-v1:0';
const BEDROCK_MODEL_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

// `global.`/`us.`/`eu.`/`apac.` prefixes identify cross-region inference profiles;
// the foundation-model ARNs use the bare model id.
function foundationModelId(modelId: string): string {
  return modelId.replace(/^(global|us|eu|apac|us-gov)\./, '');
}

export interface AgentStackProps {
  stackPrefix: string;
  toolLambdaArns: {
    listarCatalogo: string;
    registrarIntencao: string;
    realizarCompra: string;
  };
}

export interface AgentRuntimeOutputs {
  agentRuntimeArn: string;
  agentRuntimeId: string;
  ecrRepositoryUri: string;
}

export class AgentStack extends Construct {
  public readonly agentRuntimeArn: string;
  public readonly agentRuntimeId: string;
  public readonly ecrRepositoryUri: string;
  public readonly agentRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id);

    const { stackPrefix, toolLambdaArns } = props;
    const prefix = `${stackPrefix}-`;
    const MODEL_ID = optionalEnv('BEDROCK_MODEL_ID', DEFAULT_MODEL_ID);
    const FOUNDATION_MODEL_ID = foundationModelId(MODEL_ID);

    // CDK constrói e publica a imagem antes de criar o runtime.
    const image = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: path.join(__dirname, '..', '..', 'agent'),
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    this.ecrRepositoryUri = image.repository.repositoryUri;

    // IAM role for the AgentCore Runtime
    this.agentRole = new iam.Role(this, 'AgentRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      roleName: `${prefix}agent-runtime-role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Permissions for the agent runtime to invoke tool Lambdas
    this.agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          toolLambdaArns.listarCatalogo,
          toolLambdaArns.registrarIntencao,
          toolLambdaArns.realizarCompra,
        ],
      })
    );

    // ECR pull for the runtime image (GetAuthorizationToken has no resource scope in AWS)
    this.agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
    this.agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: [image.repository.repositoryArn],
      })
    );

    // Bedrock Converse (Claude Haiku via inference profile US)
    this.agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        resources: [
          `arn:aws:bedrock:us-east-1:${cdk.Aws.ACCOUNT_ID}:inference-profile/${MODEL_ID}`,
          // global.* inference profiles resolvem para ARNs de foundation-model sem região
          `arn:aws:bedrock:::foundation-model/${FOUNDATION_MODEL_ID}`,
          ...BEDROCK_MODEL_REGIONS.map(
            (region) => `arn:aws:bedrock:${region}::foundation-model/${FOUNDATION_MODEL_ID}`
          ),
        ],
      })
    );

    // AgentCore Runtime via Custom Resource (CloudFormation ainda não tem
    // AWS::BedrockAgentCore::AgentRuntime; chamamos a API de controle via SDK)
    const makeProviderFn = (id: string, handler: string) => {
      const fn = new nodejs.NodejsFunction(this, id, {
        entry: path.join(__dirname, '..', 'lambda', 'agent-runtime', 'index.ts'),
        handler,
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.minutes(2),
        bundling: { minify: true, externalModules: [] },
      });

      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:CreateAgentRuntime',
            'bedrock-agentcore:UpdateAgentRuntime',
            'bedrock-agentcore:DeleteAgentRuntime',
            'bedrock-agentcore:GetAgentRuntime',
            'bedrock-agentcore:ListAgentRuntimes',
            'bedrock-agentcore:CreateAgentRuntimeEndpoint',
            'bedrock-agentcore:UpdateAgentRuntimeEndpoint',
            'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
            'bedrock-agentcore:GetAgentRuntimeEndpoint',
            'bedrock-agentcore:ListAgentRuntimeEndpoints',
            'bedrock-agentcore:TagResource',
            'bedrock-agentcore:ListTagsForResource',
            'bedrock-agentcore:CreateWorkloadIdentity',
            'bedrock-agentcore:GetWorkloadIdentity',
            'bedrock-agentcore:UpdateWorkloadIdentity',
            'bedrock-agentcore:DeleteWorkloadIdentity',
            'bedrock-agentcore:ListWorkloadIdentities',
          ],
          resources: [
            `arn:aws:bedrock-agentcore:us-east-1:${cdk.Aws.ACCOUNT_ID}:runtime/*`,
            `arn:aws:bedrock-agentcore:us-east-1:${cdk.Aws.ACCOUNT_ID}:workload-identity-directory/*`,
          ],
        })
      );

      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [this.agentRole.roleArn],
        })
      );

      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: [
            `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/aws-service-role/bedrock-agentcore.amazonaws.com/*`,
            `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity`,
          ],
        })
      );

      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: [
            `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity`,
          ],
          conditions: {
            StringEquals: {
              'iam:AWSServiceName': 'runtime-identity.bedrock-agentcore.amazonaws.com',
            },
          },
        })
      );

      return fn;
    };

    const onEventFn = makeProviderFn('AgentRuntimeOnEvent', 'onEvent');
    const isCompleteFn = makeProviderFn('AgentRuntimeIsComplete', 'isComplete');

    const provider = new customResources.Provider(this, 'AgentRuntimeProviderFramework', {
      onEventHandler: onEventFn,
      isCompleteHandler: isCompleteFn,
      totalTimeout: cdk.Duration.minutes(15),
      queryInterval: cdk.Duration.seconds(15),
    });

    const agentRuntime = new cdk.CustomResource(this, 'AgentRuntime', {
      serviceToken: provider.serviceToken,
      properties: {
        AgentRuntimeName: `${stackPrefix.replace(/-/g, '_')}_agent`,
        ContainerUri: image.imageUri,
        RoleArn: this.agentRole.roleArn,
        EnvironmentVariables: {
          BEDROCK_MODEL_ID: MODEL_ID,
          TOOL_LISTAR_CATALOGO_ARN: toolLambdaArns.listarCatalogo,
          TOOL_REGISTRAR_INTENCAO_ARN: toolLambdaArns.registrarIntencao,
          TOOL_REALIZAR_COMPRA_ARN: toolLambdaArns.realizarCompra,
        },
      },
    });

    this.agentRuntimeArn = agentRuntime.getAttString('AgentRuntimeArn');
    this.agentRuntimeId = agentRuntime.getAttString('AgentRuntimeId');

    new cdk.CfnOutput(this, 'AgentRuntimeArn', { value: this.agentRuntimeArn });
    new cdk.CfnOutput(this, 'AgentRuntimeId', { value: this.agentRuntimeId });
    new cdk.CfnOutput(this, 'EcrRepositoryUri', { value: this.ecrRepositoryUri });
  }
}
