import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface ApiStackProps {
  stackPrefix: string;
  agentRuntimeArn: string;
  usuariosTable: dynamodb.Table;
  conversasTable: dynamodb.Table;
  intencoesTable: dynamodb.Table;
  frontendUrl: string;
}

export class ApiStack extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly chatFn: nodejs.NodejsFunction;
  public readonly api: apigw.RestApi;
  public readonly apiUrl: string;
  public readonly apiDomain: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id);

    const { stackPrefix, agentRuntimeArn, usuariosTable, conversasTable, intencoesTable, frontendUrl } = props;
    const prefix = `${stackPrefix}-`;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      // Usuários criados pelo console/CLI recebem este convite por e-mail.
      userInvitation: {
        emailSubject: 'Convite — Agente de Pagamentos',
        emailBody:
          'Você foi convidado para o Agente de Pagamentos.\n\n' +
          'Usuário: {username}\nSenha temporária: {####}\n\n' +
          'No primeiro acesso será necessário definir uma nova senha.',
      },
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

    this.chatFn = new nodejs.NodejsFunction(this, 'ChatFn', {
      functionName: `${prefix}chat`,
      entry: path.join(__dirname, '..', '..', 'api', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        AGENT_RUNTIME_ARN: agentRuntimeArn,
        USUARIOS_TABLE: usuariosTable.tableName,
        CONVERSAS_TABLE: conversasTable.tableName,
        INTENCOES_TABLE: intencoesTable.tableName,
        LIMITE_INICIAL_CENTAVOS: '50000',
        FRONTEND_URL: frontendUrl,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: [],
      },
    });

    // Permissão para o chatFn invocar o AgentCore Runtime
    this.chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          agentRuntimeArn,
          `${agentRuntimeArn}/runtime-endpoint/*`,
        ],
      })
    );

    // Registro de usuários: o chat cria o item em Usuarios no primeiro acesso.
    this.chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [usuariosTable.tableArn],
      })
    );

    // Estado de checkout por conversa: pending_intencao_id.
    this.chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [conversasTable.tableArn],
      })
    );

    // A Lambda verifica se o pending_intencao_id ainda está pendente.
    this.chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [intencoesTable.tableArn],
      })
    );

    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: `${prefix}api`,
      description: 'Desafio 1 - API do chat de pagamentos',
      defaultCorsPreflightOptions: {
        allowOrigins: [frontendUrl],
        allowMethods: ['POST', 'OPTIONS'],
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

    // CORS também nas respostas de erro geradas pelo API Gateway (401/4xx/5xx)
    const corsHeaders = {
      'Access-Control-Allow-Origin': `'${frontendUrl}'`,
      'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
      'Access-Control-Allow-Methods': "'POST,OPTIONS'",
    };

    const gatewayResponseProps = {
      responseHeaders: corsHeaders,
    };

    this.api.addGatewayResponse('Unauthorized', {
      type: apigw.ResponseType.UNAUTHORIZED,
      ...gatewayResponseProps,
    });
    this.api.addGatewayResponse('AccessDenied', {
      type: apigw.ResponseType.ACCESS_DENIED,
      ...gatewayResponseProps,
    });
    this.api.addGatewayResponse('Default4XX', {
      type: apigw.ResponseType.DEFAULT_4XX,
      ...gatewayResponseProps,
    });
    this.api.addGatewayResponse('Default5XX', {
      type: apigw.ResponseType.DEFAULT_5XX,
      ...gatewayResponseProps,
    });

    this.apiUrl = this.api.url;
    this.apiDomain = this.api.url.replace('https://', '').replace(/\/.*$/, '');
  }
}
