
import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // O runtime existente será preservado.
    const agentRuntimeArn =
      "arn:aws:bedrock-agentcore:us-east-1:021019538737:runtime/heleno_agentic_payments-7ilJ5v9m4Z";

    // ==========================================
    // 1. TABELAS DYNAMODB EXISTENTES
    // ==========================================

    const catalogTable = new dynamodb.Table(this, "CatalogTable", {
      tableName: "heleno-agentic-catalog",
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const usersTable = new dynamodb.Table(this, "UsersTable", {
      tableName: "heleno-agentic-users",
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const intentionsTable = new dynamodb.Table(this, "IntentionsTable", {
      tableName: "heleno-agentic-intentions",
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const transactionsTable = new dynamodb.Table(this, "TransactionsTable", {
      tableName: "heleno-agentic-transactions",
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ==========================================
    // 2. LAMBDA - LISTAR CATÁLOGO
    // ==========================================

    const listarCatalogo = new nodejs.NodejsFunction(
      this,
      "ListarCatalogoFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.resolve(
          __dirname,
          "../../tools/src/handlers/listar-catalogo.ts"
        ),
        projectRoot: path.resolve(__dirname, "../.."),
        depsLockFilePath: path.resolve(__dirname, "../package-lock.json"),
        handler: "handler",
        environment: {
          CATALOG_TABLE: catalogTable.tableName,
        },
        bundling: {
          externalModules: [],
        },
        logGroup: new logs.LogGroup(this, "CatalogLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }
    );

    catalogTable.grantReadData(listarCatalogo);

    // ==========================================
    // 3. LAMBDA - REGISTRAR INTENÇÃO
    // ==========================================

    const registrarIntencao = new nodejs.NodejsFunction(
      this,
      "RegistrarIntencaoFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.resolve(
          __dirname,
          "../../tools/src/handlers/registrar-intencao.ts"
        ),
        projectRoot: path.resolve(__dirname, "../.."),
        depsLockFilePath: path.resolve(__dirname, "../package-lock.json"),
        handler: "handler",
        environment: {
          CATALOG_TABLE: catalogTable.tableName,
          USERS_TABLE: usersTable.tableName,
          INTENTIONS_TABLE: intentionsTable.tableName,
        },
        bundling: {
          externalModules: [],
        },
        logGroup: new logs.LogGroup(this, "RegistrarIntencaoLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }
    );

    catalogTable.grantReadData(registrarIntencao);
    usersTable.grantReadData(registrarIntencao);
    intentionsTable.grantWriteData(registrarIntencao);

    // ==========================================
    // 4. LAMBDA - REALIZAR COMPRA
    // ==========================================

    const realizarCompra = new nodejs.NodejsFunction(
      this,
      "RealizarCompraFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.resolve(
          __dirname,
          "../../tools/src/handlers/realizar-compra.ts"
        ),
        projectRoot: path.resolve(__dirname, "../.."),
        depsLockFilePath: path.resolve(__dirname, "../package-lock.json"),
        handler: "handler",
        environment: {
          CATALOG_TABLE: catalogTable.tableName,
          USERS_TABLE: usersTable.tableName,
          INTENTIONS_TABLE: intentionsTable.tableName,
          TRANSACTIONS_TABLE: transactionsTable.tableName,
        },
        bundling: {
          externalModules: [],
        },
        logGroup: new logs.LogGroup(this, "RealizarCompraLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }
    );

    catalogTable.grantReadWriteData(realizarCompra);
    usersTable.grantReadWriteData(realizarCompra);
    intentionsTable.grantReadWriteData(realizarCompra);

    // A Lambda agora também precisa consultar a transação
    // original quando recebe uma repetição idempotente.
    transactionsTable.grantReadWriteData(realizarCompra);

    realizarCompra.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:TransactWriteItems"],
        resources: [
          catalogTable.tableArn,
          usersTable.tableArn,
          intentionsTable.tableArn,
          transactionsTable.tableArn,
        ],
      })
    );

    // ==========================================
    // 5. LAMBDA - CONFIRMAR PAGAMENTO
    // ==========================================

    const confirmarPagamento = new nodejs.NodejsFunction(
      this,
      "ConfirmarPagamentoFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.resolve(
          __dirname,
          "../../tools/src/handlers/confirmar-pagamento.ts"
        ),
        projectRoot: path.resolve(__dirname, "../.."),
        depsLockFilePath: path.resolve(__dirname, "../package-lock.json"),
        handler: "handler",
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          INTENTIONS_TABLE: intentionsTable.tableName,
          REALIZAR_COMPRA_ARN: realizarCompra.functionArn,
        },
        bundling: {
          externalModules: [],
        },
        logGroup: new logs.LogGroup(this, "ConfirmarPagamentoLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }
    );

    // Somente a Lambda de confirmação pode registrar
    // a autorização na tabela de intenções.
    intentionsTable.grantReadWriteData(confirmarPagamento);

    // A Lambda de confirmação pode invocar a Lambda
    // responsável pela transação financeira.
    realizarCompra.grantInvoke(confirmarPagamento);

    // ==========================================
    // 6. ROLE DO AGENTCORE
    // ==========================================

    const agentCoreRole = new iam.Role(this, "AgentCoreRuntimeRole", {
      roleName: "heleno-agentcore-runtime-role",
      assumedBy: new iam.ServicePrincipal(
        "bedrock-agentcore.amazonaws.com",
        {
          conditions: {
            StringEquals: {
              "aws:SourceAccount": this.account,
            },
            ArnLike: {
              "aws:SourceArn":
                `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
            },
          },
        }
      ),
      description:
        "Role de execução do Agentic Payments no Bedrock AgentCore",
    });

    agentCoreRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeClaudeHaiku45",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
          "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
          "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
        ],
      })
    );

    // O AgentCore pode consultar o catálogo e registrar
    // intenções, mas NÃO pode executar pagamentos.
    agentCoreRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokePaymentLambdas",
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          listarCatalogo.functionArn,
          registrarIntencao.functionArn,
        ],
      })
    );

    agentCoreRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreCloudWatchLogs",
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      })
    );

    agentCoreRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ECRAuthorization",
        effect: iam.Effect.ALLOW,
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      })
    );

    agentCoreRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ECRImagePull",
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchCheckLayerAvailability",
        ],
        resources: [
          `arn:aws:ecr:${this.region}:${this.account}:repository/heleno-agentic-payments`,
        ],
      })
    );

    // ==========================================
    // 7. COGNITO EXISTENTE
    // ==========================================

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "heleno-agentic-payments-users",
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      userInvitation: {
        emailSubject: "Convite - Agentic Payments",
        emailBody:
          "Seu usuário é {username} e sua senha temporária é {####}",
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient("WebAppClient", {
      userPoolClientName: "heleno-agentic-payments-web",
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      disableOAuth: true,
      preventUserExistenceErrors: true,
    });

    // ==========================================
    // 8. LAMBDA - CHAT
    // ==========================================

    const chatFunction = new nodejs.NodejsFunction(
      this,
      "ChatFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.resolve(
          __dirname,
          "../../api/src/handlers/chat.ts"
        ),
        projectRoot: path.resolve(__dirname, "../.."),
        depsLockFilePath: path.resolve(__dirname, "../package-lock.json"),
        handler: "handler",
        timeout: cdk.Duration.seconds(60),
        memorySize: 512,
        environment: {
          AGENT_RUNTIME_ARN: agentRuntimeArn,
        },
        bundling: {
          externalModules: [],
          nodeModules: ["@aws-sdk/client-bedrock-agentcore"],
        },
        logGroup: new logs.LogGroup(this, "ChatLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }
    );

    chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "InvokeAgentCoreRuntime",
        effect: iam.Effect.ALLOW,
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          agentRuntimeArn,
          `${agentRuntimeArn}/runtime-endpoint/DEFAULT`,
        ],
      })
    );

    // ==========================================
    // 9. API GATEWAY HTTP
    // ==========================================

    const httpApi = new apigatewayv2.HttpApi(
      this,
      "PaymentsHttpApi",
      {
        apiName: "heleno-agentic-payments-api",
        corsPreflight: {
          allowOrigins: [
            "http://localhost:3000",
            "http://localhost:5173",
          ],
          allowMethods: [
            apigatewayv2.CorsHttpMethod.POST,
            apigatewayv2.CorsHttpMethod.OPTIONS,
          ],
          allowHeaders: [
            "Content-Type",
            "Authorization",
          ],
        },
      }
    );

    const jwtAuthorizer = new HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
      }
    );

    // ==========================================
    // 10. ROTA /chat
    // ==========================================

    const chatIntegration = new HttpLambdaIntegration(
      "ChatLambdaIntegration",
      chatFunction
    );

    httpApi.addRoutes({
      path: "/chat",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: chatIntegration,
      authorizer: jwtAuthorizer,
    });

    // ==========================================
    // 11. ROTA /confirmar-pagamento
    // ==========================================

    const confirmarPagamentoIntegration =
      new HttpLambdaIntegration(
        "ConfirmarPagamentoLambdaIntegration",
        confirmarPagamento
      );

    httpApi.addRoutes({
      path: "/confirmar-pagamento",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: confirmarPagamentoIntegration,
      authorizer: jwtAuthorizer,
    });

    // ==========================================
    // 12. OUTPUTS
    // ==========================================

    new cdk.CfnOutput(this, "PaymentsApiUrl", {
      value: httpApi.apiEndpoint,
    });

    new cdk.CfnOutput(this, "CatalogTableName", {
      value: catalogTable.tableName,
    });

    new cdk.CfnOutput(this, "UsersTableName", {
      value: usersTable.tableName,
    });

    new cdk.CfnOutput(this, "IntentionsTableName", {
      value: intentionsTable.tableName,
    });

    new cdk.CfnOutput(this, "TransactionsTableName", {
      value: transactionsTable.tableName,
    });

    new cdk.CfnOutput(this, "ListarCatalogoArn", {
      value: listarCatalogo.functionArn,
    });

    new cdk.CfnOutput(this, "RegistrarIntencaoArn", {
      value: registrarIntencao.functionArn,
    });

    new cdk.CfnOutput(this, "RealizarCompraArn", {
      value: realizarCompra.functionArn,
    });

    new cdk.CfnOutput(this, "ConfirmarPagamentoArn", {
      value: confirmarPagamento.functionArn,
    });

    new cdk.CfnOutput(this, "AgentCoreRuntimeRoleArn", {
      value: agentCoreRole.roleArn,
    });

    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
    });

    new cdk.CfnOutput(this, "CognitoUserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
  }
}
