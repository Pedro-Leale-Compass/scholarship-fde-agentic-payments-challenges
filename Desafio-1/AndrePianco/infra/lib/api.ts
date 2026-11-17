import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { Dados } from "./dados";

const RAIZ = path.join(__dirname, "../..");

export interface ApiProps {
  dados: Dados;
  agenteRuntimeArn: string;
  /** Origens aceitas no CORS (hoje o Vite local; depois o dominio do Amplify). */
  origens: string[];
  /** Limite de gasto dado a cada usuario novo no primeiro login, em BRL. */
  limitePadrao: number;
}

/**
 * Cognito (cadastro so por convite) + API Gateway REST com autorizador
 * Cognito + Lambdas do chat (streaming) e do historico.
 */
export class Api extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly restApi: apigw.RestApi;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { dados } = props;

    const criar = (nome: string, arquivo: string, opcoes: Partial<nodejs.NodejsFunctionProps> = {}) =>
      new nodejs.NodejsFunction(this, nome, {
        entry: path.join(RAIZ, "api/src", arquivo),
        projectRoot: RAIZ,
        depsLockFilePath: path.join(RAIZ, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        logGroup: new logs.LogGroup(this, `${nome}Logs`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        bundling: { minify: true, sourceMap: false, target: "node22" },
        ...opcoes,
      });

    /* ------------------------------------------------------------ */
    /* Cognito                                                       */
    /* ------------------------------------------------------------ */

    // Cria a linha do usuario (com limite) no primeiro login.
    const provisionar = criar("ProvisionarUsuario", "provisionar-usuario.ts", {
      environment: { TABELA_USUARIOS: dados.usuarios.tableName, LIMITE_PADRAO: String(props.limitePadrao) },
    });
    dados.usuarios.grant(provisionar, "dynamodb:PutItem");

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "agente-pagamentos-usuarios",
      // Cadastro SOMENTE por convite do administrador
      // (gera AdminCreateUserConfig.AllowAdminCreateUserOnly = true).
      selfSignUpEnabled: false,
      userInvitation: {
        emailSubject: "Seu convite para o Assistente de Compras",
        emailBody:
          "Olá! Você foi convidado para o Assistente de Compras.<br><br>" +
          "Usuário: <b>{username}</b><br>Senha temporária: <b>{####}</b><br><br>" +
          "No primeiro acesso você vai definir uma nova senha.",
      },
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: { minLength: 8, requireDigits: true, requireLowercase: true, requireUppercase: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.LITE,
      lambdaTriggers: { postAuthentication: provisionar },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // App cliente publico (SPA): sem segredo, login SRP (usado pelo Amplify).
    this.client = this.userPool.addClient("Frontend", {
      userPoolClientName: "frontend",
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
    });

    /* ------------------------------------------------------------ */
    /* Lambdas da API                                                */
    /* ------------------------------------------------------------ */

    const comuns = {
      TABELA_CONVERSAS: dados.conversas.tableName,
      ORIGENS_PERMITIDAS: props.origens.join(","),
    };

    const chat = criar("Chat", "chat.ts", {
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: { ...comuns, AGENTE_RUNTIME_ARN: props.agenteRuntimeArn },
      // O client do AgentCore nao vem no runtime do Lambda: empacota o SDK.
      bundling: { minify: true, sourceMap: false, target: "node22", externalModules: [] },
    });
    // Lambda do chat: invocar o agente + ler/gravar SO a tabela de conversas.
    chat.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "InvocarAgente",
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [props.agenteRuntimeArn, `${props.agenteRuntimeArn}/runtime-endpoint/*`],
      }),
    );
    dados.conversas.grant(chat, "dynamodb:Query", "dynamodb:BatchWriteItem", "dynamodb:PutItem");

    const conversas = criar("Conversas", "conversas.ts", { environment: comuns });
    dados.conversas.grant(conversas, "dynamodb:Query", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem");

    /* ------------------------------------------------------------ */
    /* API Gateway                                                   */
    /* ------------------------------------------------------------ */

    this.restApi = new apigw.RestApi(this, "ChatApi", {
      restApiName: "agente-pagamentos-chat",
      description: "API do webchat (Desafio 1)",
      // Sem access log: exigiria configurar uma role de CloudWatch na conta
      // inteira (account settings). Os logs ficam nas Lambdas.
      cloudWatchRole: false,
      deployOptions: {
        stageName: "prod",
        // Protege a conta (e o orcamento) contra abuso.
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: props.origens,
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Respostas de erro do proprio API Gateway (401 do autorizador etc.)
    // tambem precisam de CORS, senao o navegador esconde o status.
    const corsErro = { "Access-Control-Allow-Origin": `'${props.origens[0]}'`, Vary: "'Origin'" };
    for (const [nome, tipo] of [
      ["NaoAutorizado", apigw.ResponseType.UNAUTHORIZED],
      ["AcessoNegado", apigw.ResponseType.ACCESS_DENIED],
      ["Erro4xx", apigw.ResponseType.DEFAULT_4XX],
      ["Erro5xx", apigw.ResponseType.DEFAULT_5XX],
    ] as const) {
      this.restApi.addGatewayResponse(nome, { type: tipo, responseHeaders: corsErro });
    }

    // Autorizador JWT do Cognito: requisicao sem token, expirado ou invalido
    // e recusada com 401 pelo API Gateway, sem chegar na Lambda.
    const autorizador = new apigw.CognitoUserPoolsAuthorizer(this, "Autorizador", {
      cognitoUserPools: [this.userPool],
      identitySource: "method.request.header.Authorization",
      resultsCacheTtl: cdk.Duration.minutes(5),
    });
    const protegido: apigw.MethodOptions = {
      authorizer: autorizador,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };

    this.restApi.root.addResource("chat").addMethod(
      "POST",
      new apigw.LambdaIntegration(chat, {
        responseTransferMode: apigw.ResponseTransferMode.STREAM,
        timeout: cdk.Duration.minutes(2),
      }),
      protegido,
    );

    const rotaConversas = this.restApi.root.addResource("conversas");
    const integracaoConversas = new apigw.LambdaIntegration(conversas);
    rotaConversas.addMethod("GET", integracaoConversas, protegido);
    rotaConversas.addMethod("DELETE", integracaoConversas, protegido);

  }
}
