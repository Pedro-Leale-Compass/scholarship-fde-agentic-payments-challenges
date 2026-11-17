import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';

export function chatResources(stack: Stack, prefix: string, frontendOrigin: string, tools: lambda.Function) {
  const name = `${prefix.replaceAll('-', '_')}_pagamentos`;
  const model = 'anthropic.claude-haiku-4-5-20251001-v1:0';
  const code = new Asset(stack, 'AgentCode', { path: path.resolve(__dirname, '../../../../agent/build/runtime') });
  const role = new iam.Role(stack, 'AgentRole', { assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
    conditions: { StringEquals: { 'aws:SourceAccount': stack.account }, ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:*` } },
  }) });
  role.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: [
    `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/us.${model}`,
    ...['us-east-1', 'us-east-2', 'us-west-2'].map(region => `arn:${stack.partition}:bedrock:${region}::foundation-model/${model}`),
  ] }));
  tools.grantInvoke(role);
  role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${code.bucket.bucketArn}/${code.s3ObjectKey}`] }));
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:PutResourcePolicy'],
    resources: [`arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/${name}-*`] }));
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [`arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:*`] }));
  const runtime = new CfnRuntime(stack, 'AgentRuntime', {
    agentRuntimeName: name, roleArn: role.roleArn,
    agentRuntimeArtifact: { codeConfiguration: { code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } }, entryPoint: ['index.js'], runtime: 'NODE_22' } },
    networkConfiguration: { networkMode: 'PUBLIC' }, protocolConfiguration: 'HTTP',
    lifecycleConfiguration: { idleRuntimeSessionTimeout: 60, maxLifetime: 3600 },
    environmentVariables: { MODEL_ID: `us.${model}`, TOOLS_FUNCTION: tools.functionName, AWS_REGION: stack.region },
  });
  runtime.node.addDependency(role);
  // AgentCore creates its log group during provisioning. The deployment script
  // sets retention afterwards instead of racing a second CreateLogGroup.
  const table = `${prefix}-pagamentos-conversas`;
  const functions = ['chat', 'historico'].map((suffix, index) => {
    const logGroup = new logs.LogGroup(stack, `${suffix}Logs`, { logGroupName: `/aws/lambda/${prefix}-pagamentos-${suffix}`,
      retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
    const execution = new iam.Role(stack, `${suffix}Role`, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    logGroup.grantWrite(execution);
    execution.addToPolicy(new iam.PolicyStatement({ actions: index ? ['dynamodb:GetItem', 'dynamodb:Query'] : ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: table })] }));
    if (!index) execution.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [runtime.attrAgentRuntimeArn, `${runtime.attrAgentRuntimeArn}/runtime-endpoint/DEFAULT`] }));
    return new lambda.Function(stack, `${suffix}Function`, { functionName: `${prefix}-pagamentos-${suffix}`,
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../../../agent/build/chat')), handler: index ? 'index.history' : 'index.handler',
      role: execution, logGroup, timeout: Duration.seconds(index ? 10 : 120), memorySize: 256,
      environment: { FRONTEND_ORIGIN: frontendOrigin, CONVERSATIONS_TABLE: table, AGENT_RUNTIME_ARN: runtime.attrAgentRuntimeArn },
    });
  });
  return { runtime, chat: functions[0], history: functions[1] };
}
