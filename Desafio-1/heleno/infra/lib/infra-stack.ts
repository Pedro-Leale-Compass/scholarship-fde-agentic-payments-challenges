
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

    
const listarCatalogo = new nodejs.NodejsFunction(
  this,
  "ListarCatalogoFunction",
  {
    logGroup: new logs.LogGroup(this, "CatalogLogGroup", {
  retention: logs.RetentionDays.ONE_WEEK,
  removalPolicy: cdk.RemovalPolicy.DESTROY
}),

    runtime: lambda.Runtime.NODEJS_22_X,

    entry: path.resolve(
      __dirname,
      "../../tools/src/handlers/listar-catalogo.ts"
    ),

    projectRoot: path.resolve(
      __dirname,
      "../.."
    ),

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
    }
  }
);



    catalogTable.grantReadData(listarCatalogo);

    new cdk.CfnOutput(this, "CatalogTableName", {
      value: catalogTable.tableName
    });

    new cdk.CfnOutput(this, "ListarCatalogoArn", {
      value: listarCatalogo.functionArn
    });
  }
}
