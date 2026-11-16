import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as constructs from 'constructs'
import type { Dados } from './dados.ts'

export type ToolsProps = {
  prefixo: string
  dados: Dados
}

const RAIZ = fileURLToPath(new URL('../..', import.meta.url))
const PASTA_TOOLS = path.join(RAIZ, 'tools')

export const LIMITE_PADRAO_CENTS = '100000'

export class Tools extends constructs.Construct {
  readonly listarCatalogo: nodejs.NodejsFunction
  readonly registrarIntencao: nodejs.NodejsFunction
  readonly realizarCompra: nodejs.NodejsFunction

  constructor(scope: constructs.Construct, id: string, props: ToolsProps) {
    super(scope, id)
    const { dados } = props

    const createTool = (
      idTool: string,
      nome: string,
      arquivo: string,
      environment: Record<string, string>,
      timeout: cdk.Duration,
    ) =>
      new nodejs.NodejsFunction(this, idTool, {
        functionName: `${props.prefixo}-${nome}`,
        entry: path.join(PASTA_TOOLS, 'src', arquivo),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout,
        environment,
        projectRoot: PASTA_TOOLS,
        depsLockFilePath: path.join(PASTA_TOOLS, 'package-lock.json'),
        bundling: {
          externalModules: [],
          minify: true,
          sourceMap: false,
        },
        logGroup: new logs.LogGroup(this, `${idTool}Logs`, {
          logGroupName: `/aws/lambda/${props.prefixo}-${nome}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      })

    this.listarCatalogo = createTool(
      'ListarCatalogo',
      'listar-catalogo',
      'list-catalogo.ts',
      { TABELA_CATALOGO: dados.catalogo.tableName },
      cdk.Duration.seconds(10),
    )
    dados.catalogo.grant(this.listarCatalogo, 'dynamodb:Scan')

    this.registrarIntencao = createTool(
      'RegistrarIntencao',
      'registrar-intencao',
      'register-intencao.ts',
      { TABELA_CATALOGO: dados.catalogo.tableName, TABELA_INTENCOES: dados.intencoes.tableName },
      cdk.Duration.seconds(10),
    )
    dados.catalogo.grant(this.registrarIntencao, 'dynamodb:GetItem')
    dados.intencoes.grant(this.registrarIntencao, 'dynamodb:PutItem')

    this.realizarCompra = createTool(
      'RealizarCompra',
      'realizar-compra',
      'create-compra.ts',
      {
        TABELA_USUARIOS: dados.usuarios.tableName,
        TABELA_CATALOGO: dados.catalogo.tableName,
        TABELA_INTENCOES: dados.intencoes.tableName,
        TABELA_TRANSACOES: dados.transacoes.tableName,
        LIMITE_PADRAO_CENTS,
      },
      cdk.Duration.seconds(15),
    )
    dados.intencoes.grant(this.realizarCompra, 'dynamodb:GetItem', 'dynamodb:UpdateItem')
    dados.usuarios.grant(this.realizarCompra, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem')
    dados.catalogo.grant(this.realizarCompra, 'dynamodb:UpdateItem')
    dados.transacoes.grant(this.realizarCompra, 'dynamodb:PutItem')
  }
}
