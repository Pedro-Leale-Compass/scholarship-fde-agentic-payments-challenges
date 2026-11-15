import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as apigw from 'aws-cdk-lib/aws-apigateway'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'

export interface PaymentsStackProps extends cdk.StackProps {
  defaultUserLimit: number
  frontendDirectory?: string
}

export class PaymentsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PaymentsStackProps) {
    super(scope, id, props)

    const fellowRoot = path.resolve(__dirname, '../..')
    const frontendDirectory = props.frontendDirectory ?? path.join(fellowRoot, 'frontend', 'out')
    const removalPolicy = cdk.RemovalPolicy.DESTROY
    const modelId = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'

    const pool = new cognito.UserPool(this, 'PaymentsUsers', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: 'Convite para o Chat de Pagamentos',
        emailBody: 'Olá {username}, seu código temporário é {####}. Acesse o aplicativo para definir sua senha.',
      },
      removalPolicy,
    })
    const userClient = pool.addClient('PaymentsWebClient', {
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(7),
    })

    const paymentsTable = new dynamodb.Table(this, 'PaymentsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy,
    })
    const conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy,
    })

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      autoDeleteObjects: true,
      removalPolicy,
    })
    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(1) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(1) },
      ],
    })
    const toolsDir = path.join(fellowRoot, 'tools')
    const toolsBundle = path.join(toolsDir, 'build', 'lambda')
    const appLogGroup = (id: string) => new logs.LogGroup(this, id, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    })
    const toolFunctions = [
      { id: 'ListCatalog', handler: 'listarCatalogoHandler' },
      { id: 'RegisterIntent', handler: 'registrarIntencaoHandler' },
      { id: 'MakePurchase', handler: 'realizarCompraHandler' },
    ].map(({ id, handler }) => new lambda.Function(this, id, {
      code: lambda.Code.fromAsset(toolsBundle),
      handler: `lambda-handlers.${handler}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      logGroup: appLogGroup(`${id}LogGroup`),
      memorySize: 256,
      timeout: cdk.Duration.seconds(20),
      environment: {
        PAYMENTS_TABLE_NAME: paymentsTable.tableName,
        DEFAULT_USER_LIMIT: String(props.defaultUserLimit),
      },
    }))
    const dataPolicy = (actions: string[], keys: string[]) => new iam.PolicyStatement({
      actions,
      resources: [paymentsTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': keys } },
    })
    toolFunctions.forEach((fn, index) => {
      const actions = index === 0
        ? ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']
        : index === 1
          ? ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']
          : ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:TransactWriteItems']
      fn.addToRolePolicy(dataPolicy(actions, ['CATALOG', 'USER#*']))
    })

    const runtimeRole = new iam.Role(this, 'AgentRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account }, ArnLike: { 'aws:SourceArn': `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:*` } },
      }),
    })
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${modelId}`,
        ...['us-east-1', 'us-east-2', 'us-west-2'].map((region) =>
          `arn:${this.partition}:bedrock:${region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`),
      ],
    }))
    toolFunctions.forEach((fn) => fn.grantInvoke(runtimeRole))
    const agentCodeDirectory = path.join(fellowRoot, 'agent', 'build', 'site')
    const agentArtifact = agentcore.AgentRuntimeArtifact.fromCodeAsset({
      path: agentCodeDirectory,
      runtime: agentcore.AgentCoreRuntime.PYTHON_3_12,
      entrypoint: ['main.py'],
    })
    const runtime = new agentcore.Runtime(this, 'PaymentsAgentRuntime', {
      runtimeName: 'vinicius_payments_agent',
      agentRuntimeArtifact: agentArtifact,
      executionRole: runtimeRole,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
      environmentVariables: {
        AWS_REGION: this.region,
        BEDROCK_MODEL_ID: modelId,
        LISTAR_CATALOGO_LAMBDA: toolFunctions[0].functionName,
        REGISTRAR_INTENCAO_LAMBDA: toolFunctions[1].functionName,
        REALIZAR_COMPRA_LAMBDA: toolFunctions[2].functionName,
      },
    })
    const apiBundle = path.join(fellowRoot, 'api', 'build', 'lambda')
    const apiHandler = new lambda.Function(this, 'ChatApi', {
      code: lambda.Code.fromAsset(apiBundle),
      handler: 'handler.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      logGroup: appLogGroup('ChatApiLogGroup'),
      memorySize: 512,
      timeout: cdk.Duration.minutes(15),
      environment: {
        CONVERSATIONS_TABLE_NAME: conversationsTable.tableName,
        AGENT_RUNTIME_ARN: runtime.agentRuntimeArn,
        FRONTEND_ORIGIN: `https://${distribution.distributionDomainName}`,
      },
    })
    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:TransactWriteItems'],
      resources: [conversationsTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*'] } },
    }))
    runtime.grantInvoke(apiHandler)


    const authorizerFn = new lambda.Function(this, 'CognitoTokenAuthorizer', {
      code: lambda.Code.fromAsset(apiBundle),
      handler: 'authorizer.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      logGroup: appLogGroup('CognitoAuthorizerLogGroup'),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      environment: { COGNITO_USER_POOL_ID: pool.userPoolId, COGNITO_CLIENT_ID: userClient.userPoolClientId },
    })
    const api = new apigw.RestApi(this, 'PaymentsApi', {
      deployOptions: { stageName: 'prod', tracingEnabled: true },
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: true,
    })
    const authorizer = new apigw.TokenAuthorizer(this, 'CognitoAuthorizer', {
      handler: authorizerFn,
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.seconds(0),
    })
    const integration = new apigw.LambdaIntegration(apiHandler, {
      proxy: true,
      responseTransferMode: apigw.ResponseTransferMode.STREAM,
    })
    const chatResource = api.root.addResource('chat')
    const conversationResource = api.root.addResource('conversations').addResource('{conversationId}')
    chatResource.addMethod('POST', integration, { authorizer })
    conversationResource.addMethod('GET', integration, { authorizer })

    chatResource.addCorsPreflight({
      allowOrigins: [`https://${distribution.distributionDomainName}`],
      allowMethods: ['POST', 'OPTIONS'], allowHeaders: ['Authorization', 'Content-Type'],
    })
    conversationResource.addCorsPreflight({
      allowOrigins: [`https://${distribution.distributionDomainName}`],
      allowMethods: ['GET', 'OPTIONS'], allowHeaders: ['Authorization', 'Content-Type'],
    })
    api.addGatewayResponse('ApiClientErrorCors', {
      type: apigw.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': `'https://${distribution.distributionDomainName}'`,
        'Access-Control-Allow-Headers': "'Authorization,Content-Type'",
        'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
      },
    })

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [
        s3deploy.Source.asset(frontendDirectory),
        s3deploy.Source.data('config.json', JSON.stringify({ apiUrl: api.url, userPoolId: pool.userPoolId, userPoolClientId: userClient.userPoolClientId })),
      ],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true,
    })


    new cdk.CfnOutput(this, 'FrontendUrl', { value: `https://${distribution.distributionDomainName}` })
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url })
    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId })
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userClient.userPoolClientId })
    new cdk.CfnOutput(this, 'PaymentsTableName', { value: paymentsTable.tableName })
    new cdk.CfnOutput(this, 'ConversationsTableName', { value: conversationsTable.tableName })
    new cdk.CfnOutput(this, 'AgentRuntimeArn', { value: runtime.agentRuntimeArn })
    new cdk.CfnOutput(this, 'SelectedBedrockModelId', { value: modelId })
  }
}
