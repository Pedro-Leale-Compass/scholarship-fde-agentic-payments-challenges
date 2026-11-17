import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { join } from 'node:path';

const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const FOUNDATION_MODEL_ID = MODEL_ID.replace(/^us\./, '');
const MODEL_DESTINATION_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];
const LOCAL_FRONTEND_ORIGIN = 'http://localhost:3000';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restrictRolePolicy(
  role: iam.IRole,
  transform: (
    statements: Record<string, unknown>[],
  ) => Record<string, unknown>[],
) {
  if (!(role instanceof iam.Role)) {
    throw new Error('Expected a concrete IAM role');
  }
  const defaultPolicy = role.node.tryFindChild('DefaultPolicy');
  if (!(defaultPolicy instanceof iam.Policy)) {
    throw new Error(`Default policy not found for role ${role.roleName}`);
  }
  const cfnPolicy = defaultPolicy.node.defaultChild;
  if (!(cfnPolicy instanceof iam.CfnPolicy)) {
    throw new Error(`CloudFormation policy not found for role ${role.roleName}`);
  }

  cfnPolicy.addOverride(
    'Properties.PolicyDocument.Statement',
    cdk.Lazy.any({
      // Resolve after the CDK source bindings add their deployment grants.
      produce: () => {
        const statements = defaultPolicy.document.toJSON().Statement;
        if (!Array.isArray(statements) || !statements.every(isRecord)) {
          throw new Error(`Invalid policy document for role ${role.roleName}`);
        }
        return transform(statements);
      },
    }),
  );
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const prefix = 'AlanLorenz';
    const billing = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      maxReadRequestUnits: 5,
      maxWriteRequestUnits: 5,
    };

    const productsTable = new dynamodb.Table(this, 'ProductsTable', {
      tableName: `${prefix}-Produtos`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      ...billing,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: `${prefix}-Usuarios`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      ...billing,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: `${prefix}-Conversas`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'messageKey', type: dynamodb.AttributeType.STRING },
      ...billing,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const intentionsTable = new dynamodb.Table(this, 'IntentionsTable', {
      tableName: `${prefix}-Intencoes`,
      partitionKey: { name: 'intentionId', type: dynamodb.AttributeType.STRING },
      ...billing,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const transactionsTable = new dynamodb.Table(this, 'TransactionsTable', {
      tableName: `${prefix}-Transacoes`,
      partitionKey: { name: 'intentionId', type: dynamodb.AttributeType.STRING },
      ...billing,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-Usuarios`,
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: `Convite para ${prefix}`,
        emailBody: 'Você foi convidado. Usuário: {username}. Senha temporária: {####}.',
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: `${prefix}-FrontendLocal`,
      generateSecret: false,
      authFlows: { userSrp: true },
      disableOAuth: true,
      preventUserExistenceErrors: true,
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      { cognitoUserPools: [userPool] },
    );

    const projectRoot = join(__dirname, '..');
    const toolsRoot = join(projectRoot, '..', 'tools');
    const toolEnvironment = {
      PRODUCTS_TABLE: productsTable.tableName,
      USERS_TABLE: usersTable.tableName,
      INTENTIONS_TABLE: intentionsTable.tableName,
      TRANSACTIONS_TABLE: transactionsTable.tableName,
    };

    const createToolLambda = (
      id: string,
      functionName: string,
      entry: string,
    ) => {
      const logGroup = new logs.LogGroup(this, `${id}LogGroup`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const role = new iam.Role(this, `${id}Role`, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      logGroup.grantWrite(role);

      const fn = new nodejs.NodejsFunction(this, id, {
        entry: join(toolsRoot, 'src', 'handlers', entry),
        projectRoot: toolsRoot,
        depsLockFilePath: join(toolsRoot, 'package-lock.json'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        functionName,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        logGroup,
        role,
        environment: toolEnvironment,
      });
      return { fn, role };
    };

    const addTablePermissions = (
      role: iam.Role,
      table: dynamodb.Table,
      ...actions: string[]
    ) => {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions,
          resources: [table.tableArn],
        }),
      );
    };

    const catalogTool = createToolLambda(
      'ListCatalogTool',
      `${prefix}-ListCatalog`,
      'listar-catalogo.ts',
    );
    addTablePermissions(catalogTool.role, productsTable, 'dynamodb:Scan');

    const intentionTool = createToolLambda(
      'RegisterIntentionTool',
      `${prefix}-RegisterIntention`,
      'registrar-intencao.ts',
    );
    addTablePermissions(intentionTool.role, productsTable, 'dynamodb:GetItem');
    addTablePermissions(
      intentionTool.role,
      usersTable,
      'dynamodb:GetItem',
      'dynamodb:PutItem',
    );
    addTablePermissions(intentionTool.role, intentionsTable, 'dynamodb:PutItem');

    const purchaseTool = createToolLambda(
      'RealizarCompraTool',
      `${prefix}-RealizarCompra`,
      'realizar-compra.ts',
    );
    addTablePermissions(
      purchaseTool.role,
      intentionsTable,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
      'dynamodb:TransactWriteItems',
    );
    addTablePermissions(
      purchaseTool.role,
      usersTable,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
      'dynamodb:TransactWriteItems',
    );
    addTablePermissions(
      purchaseTool.role,
      productsTable,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
      'dynamodb:TransactWriteItems',
    );
    addTablePermissions(
      purchaseTool.role,
      transactionsTable,
      'dynamodb:PutItem',
      'dynamodb:TransactWriteItems',
    );

    const agentRuntime = new bedrockagentcore.Runtime(this, 'ChatAgentRuntime', {
      runtimeName: `${prefix}ChatAgent`,
      agentRuntimeArtifact: bedrockagentcore.AgentRuntimeArtifact.fromCodeAsset({
        path: join(projectRoot, '..', 'agent', 'dist'),
        runtime: bedrockagentcore.AgentCoreRuntime.PYTHON_3_13,
        entrypoint: ['main.py'],
      }),
      environmentVariables: {
        BEDROCK_MODEL_ID: MODEL_ID,
        LIST_CATALOG_FUNCTION: catalogTool.fn.functionName,
        REGISTER_INTENTION_FUNCTION: intentionTool.fn.functionName,
        REALIZAR_COMPRA_FUNCTION: purchaseTool.fn.functionName,
      },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: cdk.Duration.seconds(300),
        maxLifetime: cdk.Duration.minutes(30),
      },
    });

    restrictRolePolicy(agentRuntime.role, (statements) =>
      statements.filter(
        (statement) =>
          statement.Sid !== 'XRayAccess' &&
          statement.Sid !== 'CloudWatchMetrics',
      ),
    );

    agentRuntime.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          catalogTool.fn.functionArn,
          intentionTool.fn.functionArn,
          purchaseTool.fn.functionArn,
        ],
      }),
    );

    const modelProfileArn = this.formatArn({
      service: 'bedrock',
      resource: 'inference-profile',
      resourceName: MODEL_ID,
    });
    agentRuntime.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [modelProfileArn],
      }),
    );
    agentRuntime.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: MODEL_DESTINATION_REGIONS.map(
          (region) =>
            `arn:${this.partition}:bedrock:${region}::foundation-model/${FOUNDATION_MODEL_ID}`,
        ),
        conditions: {
          StringLike: { 'bedrock:InferenceProfileArn': modelProfileArn },
        },
      }),
    );

    const apiRoot = join(projectRoot, '..', 'api');
    const chatLogGroup = new logs.LogGroup(this, 'ChatHandlerLogGroup', {
      logGroupName: `/aws/lambda/${prefix}-ChatHandler`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const chatHandlerRole = new iam.Role(this, 'ChatHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    chatLogGroup.grantWrite(chatHandlerRole);
    agentRuntime.grantInvokeRuntime(chatHandlerRole);
    addTablePermissions(chatHandlerRole, conversationsTable, 'dynamodb:PutItem');
    addTablePermissions(
      chatHandlerRole,
      usersTable,
      'dynamodb:GetItem',
      'dynamodb:PutItem',
    );

    const chatHandler = new nodejs.NodejsFunction(this, 'ChatHandler', {
      entry: join(apiRoot, 'chat.ts'),
      projectRoot: apiRoot,
      depsLockFilePath: join(apiRoot, 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      functionName: `${prefix}-ChatHandler`,
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      logGroup: chatLogGroup,
      role: chatHandlerRole,
      environment: {
        AGENT_RUNTIME_ARN: agentRuntime.agentRuntimeArn,
        CONVERSATIONS_TABLE: conversationsTable.tableName,
        USERS_TABLE: usersTable.tableName,
        FRONTEND_ORIGIN: LOCAL_FRONTEND_ORIGIN,
      },
    });

    const api = new apigateway.RestApi(this, 'ChatApi', {
      restApiName: `${prefix}-ChatApi`,
      endpointConfiguration: {
        types: [apigateway.EndpointType.REGIONAL],
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [LOCAL_FRONTEND_ORIGIN],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Conversa-Id'],
      },
    });

    api.addGatewayResponse('UnauthorizedCors', {
      type: apigateway.ResponseType.UNAUTHORIZED,
      responseHeaders: {
        'Access-Control-Allow-Origin': `'${LOCAL_FRONTEND_ORIGIN}'`,
        'Access-Control-Allow-Headers': "'Authorization,Content-Type,X-Conversa-Id'",
        'Access-Control-Allow-Methods': "'POST,OPTIONS'",
        Vary: "'Origin'",
      },
    });
    api.addGatewayResponse('AccessDeniedCors', {
      type: apigateway.ResponseType.ACCESS_DENIED,
      responseHeaders: {
        'Access-Control-Allow-Origin': `'${LOCAL_FRONTEND_ORIGIN}'`,
        'Access-Control-Allow-Headers': "'Authorization,Content-Type,X-Conversa-Id'",
        'Access-Control-Allow-Methods': "'POST,OPTIONS'",
        Vary: "'Origin'",
      },
    });

    api.root.addResource('chat').addMethod(
      'POST',
      new apigateway.LambdaIntegration(chatHandler, {
        proxy: true,
        responseTransferMode: apigateway.ResponseTransferMode.STREAM,
      }),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer,
      },
    );

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'ChatApiEndpoint', {
      value: api.urlForPath('/chat'),
    });
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: agentRuntime.agentRuntimeArn,
    });
  }
}
