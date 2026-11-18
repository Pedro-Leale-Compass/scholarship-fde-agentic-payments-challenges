import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

const RAIZ = path.join(__dirname, '..', '..');
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const MODELO_BASE = 'anthropic.claude-haiku-4-5-20251001-v1:0';

const CATALOGO = [
  { id: 'prod_001', nome: 'Mouse Gamer', categoria: 'perifericos', preco: 12990, estoque: 15 },
  { id: 'prod_002', nome: 'Teclado Mecânico', categoria: 'perifericos', preco: 34990, estoque: 8 },
  { id: 'prod_003', nome: 'Fone Bluetooth', categoria: 'audio', preco: 24990, estoque: 12 },
  { id: 'prod_004', nome: 'Notebook', categoria: 'computadores', preco: 459990, estoque: 3 },
];

export interface ChatPayProps extends StackProps {
  /** Prefixo com o nome do fellow, para não colidir com os outros na mesma conta. */
  readonly prefixo: string;
  /** Origem do front (local, por orientação do instrutor). Única origem aceita no CORS. */
  readonly origemFront: string;
}

export class ChatPayStack extends Stack {
  constructor(scope: Construct, id: string, props: ChatPayProps) {
    super(scope, id, props);
    const { prefixo, origemFront } = props;

    // ---------- DynamoDB ----------
    const tabela = (nome: string, pk: string, sk?: string) =>
      new dynamodb.Table(this, nome, {
        tableName: `${prefixo}-${nome.toLowerCase()}`,
        partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
        sortKey: sk ? { name: sk, type: dynamodb.AttributeType.STRING } : undefined,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    const usuarios = tabela('Usuarios', 'usuario_id');
    const catalogo = tabela('Catalogo', 'produto_id');
    const intencoes = tabela('Intencoes', 'intencao_id');
    const transacoes = tabela('Transacoes', 'transacao_id');
    const conversas = tabela('Conversas', 'usuario_id', 'ordem');

    // Carga inicial do catálogo no deploy (substitui o seed.py da Fase 1).
    new cr.AwsCustomResource(this, 'SeedCatalogo', {
      onCreate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: {
          RequestItems: {
            [catalogo.tableName]: CATALOGO.map((p) => ({
              PutRequest: {
                Item: {
                  produto_id: { S: p.id },
                  nome: { S: p.nome },
                  categoria: { S: p.categoria },
                  preco_centavos: { N: String(p.preco) },
                  moeda: { S: 'BRL' },
                  estoque: { N: String(p.estoque) },
                },
              },
            })),
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${prefixo}-seed-catalogo-v1`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['dynamodb:BatchWriteItem'], resources: [catalogo.tableArn] }),
      ]),
      installLatestAwsSdk: false,
    });

    // ---------- Cognito: só entra quem for convidado ----------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefixo}-chatpay`,
      selfSignUpEnabled: false, // AllowAdminCreateUserOnly = true
      signInAliases: { email: true },
      autoVerify: { email: true },
      userInvitation: {
        emailSubject: 'Convite para o ChatPay',
        emailBody:
          'Olá! Você foi convidado para o ChatPay (desafio AWS AI FDE). Usuário: {username} Senha temporária: {####} ' +
          'No primeiro acesso será pedida uma nova senha.',
      },
      passwordPolicy: { minLength: 8, requireDigits: true, requireLowercase: true, requireUppercase: false, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: `${prefixo}-web`,
      authFlows: { userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    // ---------- Lambda das tools (Python) ----------
    const toolsFn = new lambda.Function(this, 'ToolsFn', {
      functionName: `${prefixo}-tools`,
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(RAIZ, 'tools'), { exclude: ['test_*', '__pycache__', '.pytest_cache'] }),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        TABELA_USUARIOS: usuarios.tableName,
        TABELA_CATALOGO: catalogo.tableName,
        TABELA_INTENCOES: intencoes.tableName,
        TABELA_TRANSACOES: transacoes.tableName,
        LIMITE_PADRAO_CENTAVOS: '200000',
      },
      logGroup: this.logGroup('ToolsFn'),
    });
    // Só as tabelas que as tools usam; nenhuma permissão na tabela de conversas.
    usuarios.grantReadWriteData(toolsFn);
    catalogo.grantReadWriteData(toolsFn);
    intencoes.grantReadWriteData(toolsFn);
    transacoes.grantWriteData(toolsFn);

    // ---------- Agente Strands no AgentCore Runtime ----------
    const runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: `${prefixo.replace(/[^a-zA-Z0-9]/g, '_')}_chatpay`,
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(path.join(RAIZ, 'agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      description: 'Agente Strands do ChatPay (desafio 1)',
      environmentVariables: { TOOLS_FUNCTION_NAME: toolsFn.functionName, MODEL_ID },
    });
    // O agente chama o modelo e as tools; não tem acesso direto a nenhuma tabela.
    toolsFn.grantInvoke(runtime.role);
    runtime.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          // O perfil "us." roteia entre regiões dos EUA, então o modelo base precisa valer em todas elas.
          `arn:aws:bedrock:*::foundation-model/${MODELO_BASE}`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${MODEL_ID}`,
        ],
      }),
    );

    // ---------- Lambdas do webchat (Node, por causa do streaming) ----------
    const apiDir = path.join(RAIZ, 'api');
    const nodeFn = (id: string, handler: string, timeout: Duration) =>
      new NodejsFunction(this, id, {
        functionName: `${prefixo}-${handler}`,
        entry: path.join(apiDir, 'src', 'index.ts'),
        handler,
        projectRoot: apiDir,
        depsLockFilePath: path.join(apiDir, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout,
        // externalModules vazio: empacota o SDK junto, pois o cliente do AgentCore pode não existir no runtime da Lambda.
        bundling: { format: OutputFormat.CJS, minify: true, sourceMap: false, externalModules: [] },
        environment: {
          TABELA_CONVERSAS: conversas.tableName,
          AGENT_RUNTIME_ARN: runtime.agentRuntimeArn,
          // Muda a cada deploy do agente: força sessões novas, senão a sessão antiga segue no container anterior.
          AGENT_RUNTIME_VERSION: runtime.agentRuntimeVersion ?? '1',
          ALLOWED_ORIGIN: origemFront,
        },
        logGroup: this.logGroup(id),
      });
    const chatFn = nodeFn('ChatFn', 'chat', Duration.minutes(5));
    const conversasFn = nodeFn('ConversasFn', 'conversas', Duration.seconds(10));
    // Chat: invoca o agente e lê/grava conversas. Sem Bedrock e sem tabelas de compra.
    runtime.grantInvokeRuntime(chatFn);
    conversas.grantReadWriteData(chatFn);
    conversas.grantReadData(conversasFn);

    // ---------- API Gateway com autorizador Cognito ----------
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: `${prefixo}-chatpay-api`,
      cloudWatchRole: false, // conta compartilhada: não mexer na configuração de logs do API Gateway da conta inteira
      deployOptions: { stageName: 'prod', throttlingRateLimit: 5, throttlingBurstLimit: 10 },
      defaultCorsPreflightOptions: {
        allowOrigins: [origemFront],
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
      },
    });
    const corsHeaders = { 'Access-Control-Allow-Origin': `'${origemFront}'`, 'Access-Control-Allow-Headers': "'Authorization,Content-Type'" };
    // O 401 é respondido pelo próprio API Gateway; com CORS para o navegador conseguir ler o erro.
    api.addGatewayResponse('Unauthorized', { type: apigw.ResponseType.UNAUTHORIZED, statusCode: '401', responseHeaders: corsHeaders });
    api.addGatewayResponse('Default4xx', { type: apigw.ResponseType.DEFAULT_4XX, responseHeaders: corsHeaders });
    api.addGatewayResponse('Default5xx', { type: apigw.ResponseType.DEFAULT_5XX, responseHeaders: corsHeaders });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      authorizerName: `${prefixo}-cognito`,
      cognitoUserPools: [userPool],
    });
    const protegido = { authorizer, authorizationType: apigw.AuthorizationType.COGNITO };

    api.root
      .addResource('chat')
      .addMethod('POST', new apigw.LambdaIntegration(chatFn, { responseTransferMode: apigw.ResponseTransferMode.STREAM, timeout: Duration.minutes(5) }), protegido);
    api.root.addResource('conversas').addMethod('GET', new apigw.LambdaIntegration(conversasFn), protegido);

    // ---------- Saídas usadas para gerar a config do front ----------
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'Regiao', { value: this.region });
    new CfnOutput(this, 'AgentRuntimeArn', { value: runtime.agentRuntimeArn });
  }

  /** Log group dentro da stack: some no destroy, sem sobrar nada no CloudWatch. */
  private logGroup(id: string) {
    return new logs.LogGroup(this, `${id}Logs`, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
  }
}
