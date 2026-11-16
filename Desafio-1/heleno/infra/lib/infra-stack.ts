
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";
import * as logs from "aws-cdk-lib/aws-logs";

export class InfraStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // =====================================================
    // 1. TABELAS DYNAMODB
    // =====================================================

    const catalogTable = new dynamodb.Table(
      this,
      "CatalogTable",
      {
        tableName: "heleno-agentic-catalog",
        partitionKey: {
          name: "id",
          type: dynamodb.AttributeType.STRING
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY
      }
    );

    const usersTable = new dynamodb.Table(
      this,
      "UsersTable",
      {
        tableName: "heleno-agentic-users",
        partitionKey: {
          name: "id",
          type: dynamodb.AttributeType.STRING
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY
      }
    );

    const intentionsTable = new dynamodb.Table(
      this,
      "IntentionsTable",
      {
        tableName: "heleno-agentic-intentions",
        partitionKey: {
          name: "id",
          type: dynamodb.AttributeType.STRING
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY
      }
    );

    const transactionsTable = new dynamodb.Table(
      this,
      "TransactionsTable",
      {
        tableName: "heleno-agentic-transactions",
        partitionKey: {
          name: "id",
          type: dynamodb.AttributeType.STRING
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY
      }
    );

    // =====================================================
    // 2. LAMBDA: LISTAR CATALOGO
    // =====================================================

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

        depsLockFilePath: path.resolve(
          __dirname,
          "../package-lock.json"
        ),

        handler: "handler",

        environment: {
          CATALOG_TABLE: catalogTable.tableName
        },

        bundling: {
          externalModules: []
        },

        logGroup: new logs.LogGroup(
          this,
          "CatalogLogGroup",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY
          }
        )
      }
    );

    catalogTable.grantReadData(listarCatalogo);

    // =====================================================
    // 3. LAMBDA: REGISTRAR INTENCAO
    // =====================================================

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

        depsLockFilePath: path.resolve(
          __dirname,
          "../package-lock.json"
        ),

        handler: "handler",

        environment: {
          CATALOG_TABLE: catalogTable.tableName,
          USERS_TABLE: usersTable.tableName,
          INTENTIONS_TABLE: intentionsTable.tableName
        },

        bundling: {
          externalModules: []
        },

        logGroup: new logs.LogGroup(
          this,
          "RegistrarIntencaoLogGroup",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY
          }
        )
      }
    );

    catalogTable.grantReadData(registrarIntencao);
    usersTable.grantReadData(registrarIntencao);
    intentionsTable.grantWriteData(registrarIntencao);

    // =====================================================
    // 4. LAMBDA: REALIZAR COMPRA
    // =====================================================

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

        depsLockFilePath: path.resolve(
          __dirname,
          "../package-lock.json"
        ),

        handler: "handler",

        environment: {
          CATALOG_TABLE: catalogTable.tableName,
          USERS_TABLE: usersTable.tableName,
          INTENTIONS_TABLE: intentionsTable.tableName,
          TRANSACTIONS_TABLE: transactionsTable.tableName
        },

        bundling: {
          externalModules: []
        },

        logGroup: new logs.LogGroup(
          this,
          "RealizarCompraLogGroup",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY
          }
        )
      }
    );

    // Permissoes para a transacao de compra
    catalogTable.grantReadWriteData(realizarCompra);
    usersTable.grantReadWriteData(realizarCompra);
    intentionsTable.grantReadWriteData(realizarCompra);
    transactionsTable.grantWriteData(realizarCompra);
    realizarCompra.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["dynamodb:TransactWriteItems"],
        resources: [
          catalogTable.tableArn,
          usersTable.tableArn,
          intentionsTable.tableArn,
        transactionsTable.tableArn
      ]
  })
);
    

    // =====================================================
    // 5. OUTPUTS CLOUDFORMATION
    // =====================================================

    new cdk.CfnOutput(this, "CatalogTableName", {
      value: catalogTable.tableName
    });

    new cdk.CfnOutput(this, "UsersTableName", {
      value: usersTable.tableName
    });

    new cdk.CfnOutput(this, "IntentionsTableName", {
      value: intentionsTable.tableName
    });

    new cdk.CfnOutput(this, "TransactionsTableName", {
      value: transactionsTable.tableName
    });

    new cdk.CfnOutput(this, "ListarCatalogoArn", {
      value: listarCatalogo.functionArn
    });

    new cdk.CfnOutput(this, "RegistrarIntencaoArn", {
      value: registrarIntencao.functionArn
    });

    new cdk.CfnOutput(this, "RealizarCompraArn", {
      value: realizarCompra.functionArn
    });
  }
}
