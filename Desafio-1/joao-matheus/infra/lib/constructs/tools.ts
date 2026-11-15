import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { criarFuncaoComRole } from './lambda-role';

export interface ToolsConstructProps {
  tabelaProdutos: dynamodb.ITable;
  tabelaUsuarios: dynamodb.ITable;
  tabelaIntencoes: dynamodb.ITable;
  tabelaTransacoes: dynamodb.ITable;
}

export class ToolsConstruct extends Construct {
  public readonly listarCatalogo: lambda.Function;
  public readonly listarCatalogoRole: iam.Role;

  public readonly registrarIntencao: lambda.Function;
  public readonly registrarIntencaoRole: iam.Role;

  public readonly realizarCompra: lambda.Function;
  public readonly realizarCompraRole: iam.Role;

  constructor(scope: Construct, id: string, props: ToolsConstructProps) {
    super(scope, id);

    const assetCodigoTools = lambda.Code.fromAsset(
      path.join(__dirname, '../../../tools/src'),
      {
        exclude: ['__pycache__', '*.pyc'],
      }
    );

    // 1. Tool: Listar Catálogo
    const toolListar = criarFuncaoComRole(this, 'ListarCatalogo', {
      nomeFuncao: 'tool-listar-catalogo',
      descricao: 'Tool do agente para listar o catálogo de produtos no DynamoDB',
      handler: 'listar_catalogo.handler',
      code: assetCodigoTools,
      environment: {
        TABELA_PRODUTOS: props.tabelaProdutos.tableName,
      },
      initialPolicy: [
        new iam.PolicyStatement({
          sid: 'PermitirScanProdutos',
          actions: ['dynamodb:Scan'],
          resources: [props.tabelaProdutos.tableArn],
        }),
      ],
    });
    this.listarCatalogo = toolListar.funcao;
    this.listarCatalogoRole = toolListar.role;

    // 2. Tool: Registrar Intenção
    const toolRegistrar = criarFuncaoComRole(this, 'RegistrarIntencao', {
      nomeFuncao: 'tool-registrar-intencao',
      descricao: 'Tool do agente para registrar intenção de compra no DynamoDB',
      handler: 'registrar_intencao.handler',
      code: assetCodigoTools,
      environment: {
        TABELA_PRODUTOS: props.tabelaProdutos.tableName,
        TABELA_INTENCOES: props.tabelaIntencoes.tableName,
        MINUTOS_EXPIRACAO: '10',
      },
      initialPolicy: [
        new iam.PolicyStatement({
          sid: 'PermitirGetProduto',
          actions: ['dynamodb:GetItem'],
          resources: [props.tabelaProdutos.tableArn],
        }),
        new iam.PolicyStatement({
          sid: 'PermitirPutIntencao',
          actions: ['dynamodb:PutItem'],
          resources: [props.tabelaIntencoes.tableArn],
        }),
      ],
    });
    this.registrarIntencao = toolRegistrar.funcao;
    this.registrarIntencaoRole = toolRegistrar.role;

    // 3. Tool: Realizar Compra
    const toolComprar = criarFuncaoComRole(this, 'RealizarCompra', {
      nomeFuncao: 'tool-realizar-compra',
      descricao: 'Tool do agente para processar compra atômica condicional no DynamoDB',
      handler: 'realizar_compra.handler',
      code: assetCodigoTools,
      environment: {
        TABELA_INTENCOES: props.tabelaIntencoes.tableName,
        TABELA_USUARIOS: props.tabelaUsuarios.tableName,
        TABELA_TRANSACOES: props.tabelaTransacoes.tableName,
        LIMITE_PADRAO: '500.00',
      },
      initialPolicy: [
        new iam.PolicyStatement({
          sid: 'PermitirGerenciarIntencoes',
          actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
          resources: [props.tabelaIntencoes.tableArn],
        }),
        new iam.PolicyStatement({
          sid: 'PermitirGerenciarUsuarios',
          actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
          resources: [props.tabelaUsuarios.tableArn],
        }),
        new iam.PolicyStatement({
          sid: 'PermitirPutTransacoes',
          actions: ['dynamodb:PutItem'],
          resources: [props.tabelaTransacoes.tableArn],
        }),
      ],
    });
    this.realizarCompra = toolComprar.funcao;
    this.realizarCompraRole = toolComprar.role;
  }
}
