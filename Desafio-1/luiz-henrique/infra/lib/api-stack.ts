import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface ApiStackProps {
  stackPrefix: string;
  agentRuntimeArn: string;
  usuariosTable: dynamodb.Table;
  conversasTable: dynamodb.Table;
  conexoesTable: dynamodb.Table;
  frontendUrl: string;
}

export class ApiStack extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly chatFn: nodejs.NodejsFunction;
  public readonly webSocketFn: nodejs.NodejsFunction;
  public readonly webSocketUrl: string;
  public readonly api: apigw.RestApi;
  public readonly apiUrl: string;
  public readonly apiDomain: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id);

    const { stackPrefix, agentRuntimeArn, usuariosTable, conversasTable, conexoesTable, frontendUrl } = props;
    const prefix = `${stackPrefix}-`;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      // Usuários criados pelo console/CLI recebem este convite por e-mail.
      userInvitation: {
        emailSubject: 'Convite AWS Desafio 1 (Luiz Henrique)',
        emailBody:
          'Credenciais para testar o Agente de Pagamentos do Luiz Henrique<br><br>' +
          'Usuário: {username}<br>' +
          'Senha temporária: {####}<br><br>' +
          'No primeiro acesso será pedido pra definir uma nova senha.<br>' +
          `Seu saldo inicial é de R$ 500,00 (quinhentos reais).`,
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
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ],
        resources: [conversasTable.tableArn, `${conversasTable.tableArn}/index/*`],
      })
    );


    // WebSocket: o cliente envia o ID token do Cognito na query string.
    // O handler valida o token, guarda a conexão e delega o chat para a ChatFn.
    this.webSocketFn = new nodejs.NodejsFunction(this, 'WebSocketFn', {
      functionName: `${prefix}ws`,
      entry: path.join(__dirname, '..', '..', 'api', 'websocket', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        CONEXOES_TABLE: conexoesTable.tableName,
        CHAT_FUNCTION_NAME: this.chatFn.functionName,
        COGNITO_USER_POOL_ID: this.userPool.userPoolId,
        COGNITO_CLIENT_ID: this.userPoolClient.userPoolClientId,
      },
      bundling: {
        target: 'node20',
        externalModules: [],
      },
    });
    conexoesTable.grantReadWriteData(this.webSocketFn);
    this.chatFn.grantInvoke(this.webSocketFn);

    const wsIntegration = new apigwv2integrations.WebSocketLambdaIntegration(
      'WsIntegration',
      this.webSocketFn
    );
    const webSocketApi = new apigwv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: `${prefix}ws`,
      description: 'Desafio 1 - chat via WebSocket',
      connectRouteOptions: { integration: wsIntegration },
      disconnectRouteOptions: { integration: wsIntegration },
      defaultRouteOptions: { integration: wsIntegration },
    });
    const webSocketStage = new apigwv2.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });
    this.webSocketUrl = `wss://${webSocketApi.apiId}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com/${webSocketStage.stageName}`;
    webSocketApi.grantManageConnections(this.webSocketFn);

    // O CDK cria permissão só para $connect; $default/$disconnect também
    // precisam invocar a Lambda, senão o API Gateway devolve Internal server error.
    this.webSocketFn.addPermission('WsRoutesPermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: webSocketApi.arnForExecuteApi(),
    });

    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: `${prefix}api`,
      description: 'Desafio 1 - API do chat de pagamentos',
      defaultCorsPreflightOptions: {
        allowOrigins: [frontendUrl],
        allowMethods: ['POST', 'GET', 'OPTIONS'],
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

    const conversasResource = this.api.root.addResource('conversas');
    conversasResource.addMethod('GET', new apigw.LambdaIntegration(this.chatFn), {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    });

    // CORS também nas respostas de erro geradas pelo API Gateway (401/4xx/5xx)
    const corsHeaders = {
      'Access-Control-Allow-Origin': `'${frontendUrl}'`,
      'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
      'Access-Control-Allow-Methods': "'POST,GET,OPTIONS'",
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
