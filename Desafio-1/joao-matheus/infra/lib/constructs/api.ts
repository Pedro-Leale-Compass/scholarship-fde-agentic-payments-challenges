import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { nome } from '../config';

export interface ApiConstructProps {
  userPool: cognito.IUserPool;
  tabelaConversas: dynamodb.ITableV2;
  agentRuntimeArn: string;
  urlFrontend: string;
  permitirLocalhost?: boolean;
}

export class ApiConstruct extends Construct {
  public readonly api: apigw.RestApi;
  public readonly chatFunction: nodejs.NodejsFunction;
  public readonly conversasFunction: nodejs.NodejsFunction;
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    // 1. Configurar origens permitidas para CORS
    const origens: string[] = [];
    if (props.urlFrontend && !origens.includes(props.urlFrontend)) {
      origens.push(props.urlFrontend);
    }
    if (props.permitirLocalhost && !origens.includes('http://localhost:5173')) {
      origens.push('http://localhost:5173');
    }
    const origensCsv = origens.join(',');

    const apiPath = path.resolve(__dirname, '../../../api');
    const lockFilePath = path.join(apiPath, 'package-lock.json');

    // -------------------------------------------------------------------------
    // 2. Lambda POST /chat (Response Streaming + Invocação AgentCore)
    // -------------------------------------------------------------------------
    const chatNome = nome('api-chat');
    const chatLogGroup = new logs.LogGroup(this, 'ChatLogGroup', {
      logGroupName: `/aws/lambda/${chatNome}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const chatRole = new iam.Role(this, 'ChatRole', {
      roleName: `${chatNome}-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Role de menor privilégio para a função ${chatNome}`,
    });

    chatRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirLogsProprioLogGroup',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [chatLogGroup.logGroupArn, `${chatLogGroup.logGroupArn}:*`],
      })
    );

    chatRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirInvocarAgentCoreRuntime',
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          props.agentRuntimeArn,
          `${props.agentRuntimeArn}/*`,
        ],
      })
    );

    chatRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirAcessoConversasDynamoDB',
        actions: ['dynamodb:Query', 'dynamodb:BatchWriteItem'],
        resources: [props.tabelaConversas.tableArn],
      })
    );

    this.chatFunction = new nodejs.NodejsFunction(this, 'ChatFunction', {
      functionName: chatNome,
      description: 'Handler streaming SSE para POST /chat',
      entry: path.join(apiPath, 'src/chat.ts'),
      handler: 'handler',
      depsLockFilePath: lockFilePath,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(300), // 5 minutos para conversação com streaming
      memorySize: 512,
      environment: {
        AGENT_RUNTIME_ARN: props.agentRuntimeArn,
        TABELA_CONVERSAS: props.tabelaConversas.tableName,
        ORIGENS_PERMITIDAS: origensCsv,
      },
      role: chatRole,
      logGroup: chatLogGroup,
      bundling: {
        externalModules: [], // Empacota dependências locais (SDK AgentCore)
        minify: true,
        sourceMap: true,
        format: nodejs.OutputFormat.CJS,
      },
    });

    // -------------------------------------------------------------------------
    // 3. Lambda GET /conversas (Consulta histórico recente)
    // -------------------------------------------------------------------------
    const conversasNome = nome('api-conversas');
    const conversasLogGroup = new logs.LogGroup(this, 'ConversasLogGroup', {
      logGroupName: `/aws/lambda/${conversasNome}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const conversasRole = new iam.Role(this, 'ConversasRole', {
      roleName: `${conversasNome}-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Role de menor privilégio para a função ${conversasNome}`,
    });

    conversasRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirLogsProprioLogGroup',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [conversasLogGroup.logGroupArn, `${conversasLogGroup.logGroupArn}:*`],
      })
    );

    conversasRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PermitirConsultaConversasDynamoDB',
        actions: ['dynamodb:Query'],
        resources: [props.tabelaConversas.tableArn],
      })
    );

    this.conversasFunction = new nodejs.NodejsFunction(this, 'ConversasFunction', {
      functionName: conversasNome,
      description: 'Consulta do historico de conversas para GET /conversas',
      entry: path.join(apiPath, 'src/conversas.ts'),
      handler: 'handler',
      depsLockFilePath: lockFilePath,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        TABELA_CONVERSAS: props.tabelaConversas.tableName,
        ORIGENS_PERMITIDAS: origensCsv,
      },
      role: conversasRole,
      logGroup: conversasLogGroup,
      bundling: {
        externalModules: [],
        minify: true,
        sourceMap: true,
        format: nodejs.OutputFormat.CJS,
      },
    });

    // -------------------------------------------------------------------------
    // 4. REST API Gateway com Cognito User Pools Authorizer
    // -------------------------------------------------------------------------
    this.api = new apigw.RestApi(this, 'RestApi', {
      restApiName: nome('webchat-api'),
      description: 'API REST para WebChat com streaming SSE e autenticação Cognito',
      endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: origens.length > 0 ? origens : apigw.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
      cloudWatchRole: false,
    });

    const autorizador = new apigw.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
      authorizerName: nome('cognito-authorizer'),
      identitySource: 'method.request.header.Authorization',
    });

    const metodoAutenticadoOpcoes: apigw.MethodOptions = {
      authorizer: autorizador,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };

    // Recurso /chat com integração de Response Streaming
    const chatResource = this.api.root.addResource('chat');
    chatResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(this.chatFunction, {
        responseTransferMode: apigw.ResponseTransferMode.STREAM,
        timeout: cdk.Duration.seconds(29), // Limite regional do API Gateway para início do stream
      }),
      metodoAutenticadoOpcoes
    );

    // Recurso /conversas com integração síncrona padrão
    const conversasResource = this.api.root.addResource('conversas');
    conversasResource.addMethod(
      'GET',
      new apigw.LambdaIntegration(this.conversasFunction),
      metodoAutenticadoOpcoes
    );

    // Gateway Responses para garantir cabeçalhos CORS em respostas de erro (401, 403, 5xx)
    const tiposRespostaErro = [
      apigw.ResponseType.UNAUTHORIZED,
      apigw.ResponseType.ACCESS_DENIED,
      apigw.ResponseType.DEFAULT_4XX,
      apigw.ResponseType.DEFAULT_5XX,
    ];

    for (const tipo of tiposRespostaErro) {
      this.api.addGatewayResponse(`GwResp${tipo.responseType}`, {
        type: tipo,
        responseHeaders: {
          'Access-Control-Allow-Origin': "'*'",
          'Access-Control-Allow-Headers': "'Authorization,Content-Type'",
          'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
        },
      });
    }

    this.apiUrl = this.api.url;
  }
}
