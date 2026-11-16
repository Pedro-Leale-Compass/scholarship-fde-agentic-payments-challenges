import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import * as apigw from 'aws-cdk-lib/aws-apigateway'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as constructs from 'constructs'
import type { Autenticacao } from './autenticacao.ts'
import type { Dados } from './dados.ts'

export type ApiProps = {
  prefixo: string
  dados: Dados
  autenticacao: Autenticacao
  agenteRuntimeArn: string
  origemPermitida: string
}

const RAIZ = fileURLToPath(new URL('../..', import.meta.url))
const PASTA_API = path.join(RAIZ, 'api')

export const TIMEOUT_CHAT = cdk.Duration.minutes(5)

export class Api extends constructs.Construct {
  readonly chat: nodejs.NodejsFunction
  readonly conversas: nodejs.NodejsFunction
  readonly restApi: apigw.RestApi
  readonly urlApi: string

  constructor(scope: constructs.Construct, id: string, props: ApiProps) {
    super(scope, id)
    const { dados, autenticacao, origemPermitida } = props

    const createLambdaApi = (
      idLambda: string,
      nome: string,
      arquivo: string,
      environment: Record<string, string>,
      timeout: cdk.Duration,
    ) =>
      new nodejs.NodejsFunction(this, idLambda, {
        functionName: `${props.prefixo}-${nome}`,
        entry: path.join(PASTA_API, 'src', arquivo),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout,
        environment,
        projectRoot: PASTA_API,
        depsLockFilePath: path.join(PASTA_API, 'package-lock.json'),
        bundling: {
          externalModules: [],
          minify: true,
          sourceMap: false,
        },
        logGroup: new logs.LogGroup(this, `${idLambda}Logs`, {
          logGroupName: `/aws/lambda/${props.prefixo}-${nome}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      })

    this.chat = createLambdaApi(
      'Chat',
      'chat',
      'stream-chat.ts',
      {
        TABELA_CONVERSAS: dados.conversas.tableName,
        AGENT_RUNTIME_ARN: props.agenteRuntimeArn,
        ORIGEM_PERMITIDA: origemPermitida,
      },
      TIMEOUT_CHAT,
    )
    dados.conversas.grant(this.chat, 'dynamodb:GetItem', 'dynamodb:UpdateItem')
    this.chat.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvocarAgente',
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [props.agenteRuntimeArn, `${props.agenteRuntimeArn}/*`],
      }),
    )

    this.conversas = createLambdaApi(
      'Conversas',
      'conversas',
      'list-conversas.ts',
      {
        TABELA_CONVERSAS: dados.conversas.tableName,
        ORIGEM_PERMITIDA: origemPermitida,
      },
      cdk.Duration.seconds(10),
    )
    dados.conversas.grant(this.conversas, 'dynamodb:GetItem', 'dynamodb:Query')

    const autorizador = new apigw.CognitoUserPoolsAuthorizer(this, 'Autorizador', {
      authorizerName: `${props.prefixo}-cognito`,
      cognitoUserPools: [autenticacao.userPool],
      identitySource: apigw.IdentitySource.header('Authorization'),
      resultsCacheTtl: cdk.Duration.minutes(5),
    })

    this.restApi = new apigw.RestApi(this, 'Api', {
      restApiName: `${props.prefixo}-api`,
      description: 'API do webchat do agente de pagamentos',
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [origemPermitida],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    })

    const headersCors = {
      'Access-Control-Allow-Origin': `'${origemPermitida}'`,
      Vary: "'Origin'",
    }
    this.restApi.addGatewayResponse('Erros4xx', { type: apigw.ResponseType.DEFAULT_4XX, responseHeaders: headersCors })
    this.restApi.addGatewayResponse('Erros5xx', { type: apigw.ResponseType.DEFAULT_5XX, responseHeaders: headersCors })

    const comAutorizador: apigw.MethodOptions = {
      authorizer: autorizador,
      authorizationType: apigw.AuthorizationType.COGNITO,
    }

    this.restApi.root
      .addResource('chat')
      .addMethod(
        'POST',
        new apigw.LambdaIntegration(this.chat, {
          responseTransferMode: apigw.ResponseTransferMode.STREAM,
          timeout: TIMEOUT_CHAT,
          allowTestInvoke: false,
        }),
        comAutorizador,
      )

    const integracaoConversas = new apigw.LambdaIntegration(this.conversas, { allowTestInvoke: false })
    const recursoConversas = this.restApi.root.addResource('conversas')
    recursoConversas.addMethod('GET', integracaoConversas, comAutorizador)
    recursoConversas.addResource('{id}').addMethod('GET', integracaoConversas, comAutorizador)

    this.urlApi = this.restApi.url
  }
}
