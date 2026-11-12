import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudformation from 'aws-cdk-lib/aws-cloudformation';
import * as path from 'path';

export interface AgentStackProps {
  stackPrefix: string;
  toolLambdaArns: {
    listarCatalogo: string;
    registrarIntencao: string;
    realizarCompra: string;
  };
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
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

    const { stackPrefix, toolLambdaArns, vpc, securityGroup } = props;
    const prefix = `${stackPrefix}-`;

    // ECR repository for the agent container image
    const ecrRepo = new ecr.Repository(this, 'AgentEcrRepository', {
      repositoryName: `${prefix}agent`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: true,
    });

    this.ecrRepositoryUri = ecrRepo.repositoryUri;

    // IAM role for the AgentCore Runtime
    this.agentRole = new iam.Role(this, 'AgentRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      roleName: `${prefix}agent-runtime-role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Permissions for the agent runtime to invoke tool Lambdas
    const toolInvokePolicy = new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        toolLambdaArns.listarCatalogo,
        toolLambdaArns.registrarIntencao,
        toolLambdaArns.realizarCompra,
      ],
    });
    this.agentRole.addToPolicy(toolInvokePolicy);

    // Permissions for Bedrock Converse (model inference)
    const bedrockInvokePolicy = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
      resources: ['*'],
    });
    this.agentRole.addToPolicy(bedrockInvokePolicy);

    // AgentCore Runtime via CloudFormation Cfn resource (no L2 CDK construct yet)
    const agentRuntime = new cloudformation.CfnResource(this, 'AgentRuntime', {
      type: 'AWS::BedrockAgentCore::AgentRuntime',
      properties: {
        AgentRuntimeName: `${prefix}agent`,
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: `${ecrRepo.repositoryUri}:latest`,
          },
        },
        RoleArn: this.agentRole.roleArn,
        NetworkConfiguration: {
          NetworkMode: 'PUBLIC',
        },
      },
    });

    this.agentRuntimeArn = agentRuntime.getAtt('AgentRuntimeArn').toString();
    this.agentRuntimeId = agentRuntime.getAtt('AgentRuntimeId').toString();

    new cdk.CfnOutput(this, 'AgentRuntimeArn', { value: this.agentRuntimeArn });
    new cdk.CfnOutput(this, 'AgentRuntimeId', { value: this.agentRuntimeId });
    new cdk.CfnOutput(this, 'EcrRepositoryUri', { value: this.ecrRepositoryUri });
  }
}
