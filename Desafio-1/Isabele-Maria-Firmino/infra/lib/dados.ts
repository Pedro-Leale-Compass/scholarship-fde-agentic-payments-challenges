import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as cr from 'aws-cdk-lib/custom-resources'
import * as constructs from 'constructs'
import produtos from '../seed/produtos.json' with { type: 'json' }

export type DadosProps = { prefixo: string }

type Produto = (typeof produtos)[number]

const TAMANHO_MAXIMO_LOTE = 25

function createItemCatalogo(produto: Produto): Record<string, Record<string, string>> {
  return {
    produto_id: { S: produto.produto_id },
    nome: { S: produto.nome },
    preco_cents: { N: String(produto.preco_cents) },
    moeda: { S: produto.moeda },
    estoque: { N: String(produto.estoque) },
    categoria: { S: produto.categoria },
  }
}

export class Dados extends constructs.Construct {
  readonly usuarios: dynamodb.TableV2
  readonly catalogo: dynamodb.TableV2
  readonly intencoes: dynamodb.TableV2
  readonly transacoes: dynamodb.TableV2
  readonly conversas: dynamodb.TableV2

  constructor(scope: constructs.Construct, id: string, props: DadosProps) {
    super(scope, id)

    const createTabela = (idTabela: string, nome: string, partitionKey: string, sortKey?: string) =>
      new dynamodb.TableV2(this, idTabela, {
        tableName: `${props.prefixo}-${nome}`,
        partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
        sortKey: sortKey ? { name: sortKey, type: dynamodb.AttributeType.STRING } : undefined,
        billing: dynamodb.Billing.onDemand(),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      })

    this.usuarios = createTabela('Usuarios', 'usuarios', 'usuario_id')
    this.catalogo = createTabela('Catalogo', 'catalogo', 'produto_id')
    this.intencoes = createTabela('Intencoes', 'intencoes', 'intencao_id')
    this.transacoes = createTabela('Transacoes', 'transacoes', 'transacao_id')
    this.conversas = createTabela('Conversas', 'conversas', 'usuario_id', 'conversa_id')

    if (produtos.length > TAMANHO_MAXIMO_LOTE) {
      throw new Error(`o seed do catálogo aceita até ${TAMANHO_MAXIMO_LOTE} produtos por lote`)
    }

    new cr.AwsCustomResource(this, 'SeedCatalogo', {
      onCreate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: {
          RequestItems: {
            [this.catalogo.tableName]: produtos.map((produto) => ({ PutRequest: { Item: createItemCatalogo(produto) } })),
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${props.prefixo}-seed-catalogo`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:BatchWriteItem'],
          resources: [this.catalogo.tableArn],
        }),
      ]),
      installLatestAwsSdk: false,
      logGroup: new logs.LogGroup(this, 'SeedCatalogoLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })
  }
}
