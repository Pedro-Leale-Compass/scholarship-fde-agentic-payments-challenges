import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { chatResources } from './chat-resources';

export interface FoundationStackProps extends StackProps { prefix: string; backendOnly?: boolean }

export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { prefix } = props;
    Tags.of(this).add('Project', 'agente-pagamentos-aws');
    Tags.of(this).add('Owner', prefix);

    let frontendOrigin = 'http://127.0.0.1:4173';
    if (!props.backendOnly) {
    const bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `${prefix}-pagamentos-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const frontendS3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);
    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: `${prefix} - pagamentos`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: frontendS3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      additionalBehaviors: {
        '_next/static/*': {
          origin: frontendS3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          compress: true,
        },
      },
    });
    frontendOrigin = `https://${distribution.distributionDomainName}`;
    new CfnOutput(this, 'FrontendBucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    }

    const pool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-pagamentos`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12, requireLowercase: true, requireUppercase: true,
        requireDigits: true, requireSymbols: true, tempPasswordValidity: Duration.days(3),
      },
      userInvitation: {
        emailSubject: 'Seu acesso ao agente de pagamentos',
        emailBody: 'Você recebeu um convite para o ambiente de demonstração. Usuário: {username}. Senha temporária: {####}. Acesse o endereço enviado pelo responsável pelo projeto e defina sua nova senha.',
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const client = pool.addClient('WebClient', {
      userPoolClientName: `${prefix}-web`,
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(1),
    });

    const logGroup = new logs.LogGroup(this, 'SessionLogs', {
      logGroupName: `/aws/lambda/${prefix}-pagamentos-sessao`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, 'SessionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logGroup.logGroupArn],
    }));
    const sessionFunction = new lambda.Function(this, 'SessionFunction', {
      functionName: `${prefix}-pagamentos-sessao`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'session.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../api')),
      role,
      logGroup,
      timeout: Duration.seconds(5),
      memorySize: 128,
      environment: { FRONTEND_ORIGIN: frontendOrigin },
    });
    const paymentLogs = new logs.LogGroup(this, 'PaymentLogs', {
      logGroupName: `/aws/lambda/${prefix}-pagamentos-tools`,
      retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY,
    });
    const paymentRole = new iam.Role(this, 'PaymentRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    paymentRole.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [paymentLogs.logGroupArn] }));
    const tableNames = { USERS_TABLE: `${prefix}-pagamentos-usuarios`, INTENTS_TABLE: `${prefix}-pagamentos-intencoes`, TRANSACTIONS_TABLE: `${prefix}-pagamentos-transacoes` };
    for (const [tableName, actions] of [
      [tableNames.USERS_TABLE, ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem']],
      [tableNames.INTENTS_TABLE, ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']],
      [tableNames.TRANSACTIONS_TABLE, ['dynamodb:GetItem', 'dynamodb:PutItem']],
    ] as const) {
      paymentRole.addToPolicy(new iam.PolicyStatement({ actions: [...actions], resources: [this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: tableName })] }));
    }
    const paymentFunction = new lambda.Function(this, 'PaymentFunction', {
      functionName: `${prefix}-pagamentos-tools`, runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../../../tools/build')),
      role: paymentRole, logGroup: paymentLogs, timeout: Duration.seconds(20), memorySize: 256,
      environment: { FRONTEND_ORIGIN: frontendOrigin, ...tableNames },
    });
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${prefix}-pagamentos`,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'v1', throttlingRateLimit: 5, throttlingBurstLimit: 10,
        loggingLevel: apigateway.MethodLoggingLevel.OFF, dataTraceEnabled: false,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [frontendOrigin],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: Duration.minutes(10),
      },
    });
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [pool],
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: Duration.seconds(0),
    });
    const session = api.root.addResource('sessao');
    session.addMethod('GET', new apigateway.LambdaIntegration(sessionFunction, {
      proxy: true, allowTestInvoke: false,
    }), { authorizationType: apigateway.AuthorizationType.COGNITO, authorizer });
    const protectedMethod = { authorizationType: apigateway.AuthorizationType.COGNITO, authorizer };
    const chat = chatResources(this, prefix, frontendOrigin, paymentFunction);
    api.root.addResource('conversas').addMethod('GET', new apigateway.LambdaIntegration(chat.history, { proxy: true, allowTestInvoke: false }), protectedMethod);
    const chatMethod = api.root.addResource('chat').addMethod('POST', new apigateway.LambdaIntegration(chat.chat, { proxy: true, allowTestInvoke: false }), protectedMethod);
    const streaming = chatMethod.node.defaultChild as apigateway.CfnMethod;
    streaming.addPropertyOverride('Integration.ResponseTransferMode', 'STREAM');
    streaming.addPropertyOverride('Integration.Uri', `arn:${this.partition}:apigateway:${this.region}:lambda:path/2021-11-15/functions/${chat.chat.functionArn}/response-streaming-invocations`);
    new CfnOutput(this, 'AgentRuntimeArn', { value: chat.runtime.attrAgentRuntimeArn });
    for (const name of ['catalogo', 'conta']) {
      api.root.addResource(name).addMethod('GET', new apigateway.LambdaIntegration(paymentFunction, { proxy: true, allowTestInvoke: false }), protectedMethod);
    }
    const intents = api.root.addResource('intencoes');
    intents.addMethod('POST', new apigateway.LambdaIntegration(paymentFunction, { proxy: true, allowTestInvoke: false }), protectedMethod);
    intents.addResource('{id}').addMethod('GET', new apigateway.LambdaIntegration(paymentFunction, { proxy: true, allowTestInvoke: false }), protectedMethod);
    api.root.addResource('compras').addMethod('POST', new apigateway.LambdaIntegration(paymentFunction, { proxy: true, allowTestInvoke: false }), protectedMethod);
    const cfnAuthorizer = authorizer.node.defaultChild as apigateway.CfnAuthorizer;
    cfnAuthorizer.identityValidationExpression = `^${client.userPoolClientId}$`;

    for (const [name, type] of [
      ['Unauthorized', apigateway.ResponseType.UNAUTHORIZED],
      ['ClientError', apigateway.ResponseType.DEFAULT_4XX],
      ['ServerError', apigateway.ResponseType.DEFAULT_5XX],
    ] as const) {
      api.addGatewayResponse(name, {
        type,
        ...(name === 'Unauthorized' ? { statusCode: '401' } : {}),
        responseHeaders: {
          'Access-Control-Allow-Origin': `'${frontendOrigin}'`,
          'Access-Control-Allow-Headers': "'Authorization,Content-Type'",
          'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
        },
      });
    }

    new CfnOutput(this, 'FrontendUrl', { value: frontendOrigin });
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'Region', { value: this.region });
  }
}
