import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export interface ToolsStackProps {
  stackPrefix: string;
  intencoesTable: dynamodb.Table;
  usuariosTable: dynamodb.Table;
  catalogoTable: dynamodb.Table;
}

export interface ToolLambdaArns {
  listarCatalogo: string;
  registrarIntencao: string;
  realizarCompra: string;
}

export class ToolsStack extends Construct {
  public readonly toolLambdaArns: ToolLambdaArns;
  public readonly listarCatalogoFn: nodejs.NodejsFunction;
  public readonly registrarIntencaoFn: nodejs.NodejsFunction;
  public readonly realizarCompraFn: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ToolsStackProps) {
    super(scope, id);

    const { stackPrefix, intencoesTable, usuariosTable, catalogoTable } = props;
    const prefix = `${stackPrefix}-`;
    const toolsDir = path.join(__dirname, '..', '..', 'tools');

    const commonEnv = {
      USUARIOS_TABLE: usuariosTable.tableName,
      INTENCOES_TABLE: intencoesTable.tableName,
    };

    const makeFn = (name: string, dir: string, environment: Record<string, string>) =>
      new nodejs.NodejsFunction(this, name, {
        functionName: `${prefix}${dir.replace(/_/g, '-')}`,
        entry: path.join(toolsDir, dir, 'index.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        environment,
        bundling: {
          minify: true,
          sourceMap: false,
          externalModules: [],
        },
      });

    this.listarCatalogoFn = makeFn('ListarCatalogoFn', 'listar_catalogo', {
      ...commonEnv,
      CATALOGO_TABLE: catalogoTable.tableName,
    });

    this.registrarIntencaoFn = makeFn('RegistrarIntencaoFn', 'registrar_intencao', {
      ...commonEnv,
      CATALOGO_TABLE: catalogoTable.tableName,
    });

    this.realizarCompraFn = makeFn('RealizarCompraFn', 'realizar_compra', commonEnv);

    // Menor privilégio: cada tool só acessa as tabelas que realmente usa.
    this.listarCatalogoFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Scan'],
        resources: [catalogoTable.tableArn],
      }),
    );

    this.registrarIntencaoFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [intencoesTable.tableArn],
      }),
    );
    this.registrarIntencaoFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [catalogoTable.tableArn],
      }),
    );

    this.realizarCompraFn.addToRolePolicy(
      new iam.PolicyStatement({
        // TransactWriteItems é autorizado pelas ações de item (UpdateItem), não por
        // "dynamodb:TransactWriteItems".
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:TransactWriteItems'],
        resources: [intencoesTable.tableArn, usuariosTable.tableArn],
      }),
    );

    this.toolLambdaArns = {
      listarCatalogo: this.listarCatalogoFn.functionArn,
      registrarIntencao: this.registrarIntencaoFn.functionArn,
      realizarCompra: this.realizarCompraFn.functionArn,
    };
  }
}
