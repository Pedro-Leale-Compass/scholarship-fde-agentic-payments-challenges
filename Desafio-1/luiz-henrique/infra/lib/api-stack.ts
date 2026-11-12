import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface ApiStackProps {
  stackPrefix: string;
  agentFnArn: string;
  usuariosTable: dynamodb.Table;
}

export class ApiStack extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly chatFn: lambda.Function;
  public readonly api: apigw.RestApi;
  public readonly apiUrl: string;
  public readonly apiDomain: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id);

    const { stackPrefix, agentFnArn, usuariosTable } = props;
    const prefix = `${stackPrefix}-`;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `${prefix}client`,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
    });

    const isLocalProfile = process.env.AWS_PROFILE === 'local';
    const bedrockEndpoint = process.env.BEDROCK_ENDPOINT_URL || (isLocalProfile ? 'http://localhost:4566' : '');

    this.chatFn = new lambda.Function(this, 'ChatFn', {
      functionName: `${prefix}chat`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'api')),
      environment: {
        AGENT_FN_ARN: agentFnArn,
        USUARIOS_TABLE: usuariosTable.tableName,
        BEDROCK_ENDPOINT_URL: bedrockEndpoint,
        BEDROCK_MODEL_ID: 'qwen3.5',
      },
    });

    this.chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [agentFnArn],
      })
    );

    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: `${prefix}api`,
      description: 'Desafio 1 - API do chat de pagamentos',
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        stageName: 'prod',
      },
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'JwtAuthorizer', {
      cognitoUserPools: [this.userPool],
      authorizerName: `${prefix}cognito-authorizer`,
      identitySource: 'method.request.header.Authorization',
    });

    const chatResource = this.api.root.addResource('chat');
    chatResource.addMethod('POST', new apigw.LambdaIntegration(this.chatFn), {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    });

    this.apiUrl = this.api.url;
    this.apiDomain = this.api.url.replace('https://', '').replace(/\/.*$/, '');
  }
}
