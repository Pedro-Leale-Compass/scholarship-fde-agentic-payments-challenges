import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as custom_resources from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { nome } from '../config';
import { CATALOGO_INICIAL } from '../dados/catalogo';

export class DadosConstruct extends Construct {
  public readonly produtos: dynamodb.TableV2;
  public readonly usuarios: dynamodb.TableV2;
  public readonly intencoes: dynamodb.TableV2;
  public readonly transacoes: dynamodb.TableV2;
  public readonly conversas: dynamodb.TableV2;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // 1. Tabela produtos
    this.produtos = new dynamodb.TableV2(this, 'TabelaProdutos', {
      tableName: nome('produtos'),
      partitionKey: { name: 'produto_id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2. Tabela usuarios
    this.usuarios = new dynamodb.TableV2(this, 'TabelaUsuarios', {
      tableName: nome('usuarios'),
      partitionKey: { name: 'usuario_id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 3. Tabela intencoes
    this.intencoes = new dynamodb.TableV2(this, 'TabelaIntencoes', {
      tableName: nome('intencoes'),
      partitionKey: { name: 'intencao_id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 4. Tabela transacoes
    this.transacoes = new dynamodb.TableV2(this, 'TabelaTransacoes', {
      tableName: nome('transacoes'),
      partitionKey: { name: 'transacao_id', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 5. Tabela conversas
    this.conversas = new dynamodb.TableV2(this, 'TabelaConversas', {
      tableName: nome('conversas'),
      partitionKey: { name: 'usuario_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Seed de produtos iniciais
    const itensBatch = CATALOGO_INICIAL.map((item) => ({
      PutRequest: {
        Item: {
          produto_id: { S: item.produto_id },
          nome: { S: item.nome },
          preco: { N: item.preco.toFixed(2) },
          descricao: { S: item.descricao },
          moeda: { S: item.moeda },
        },
      },
    }));

    const seedLogGroup = new logs.LogGroup(this, 'SeedProdutosLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new custom_resources.AwsCustomResource(this, 'SeedProdutos', {
      onCreate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: {
          RequestItems: {
            [this.produtos.tableName]: itensBatch,
          },
        },
        physicalResourceId: custom_resources.PhysicalResourceId.of('seed-produtos-v1'),
      },
      onUpdate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: {
          RequestItems: {
            [this.produtos.tableName]: itensBatch,
          },
        },
        physicalResourceId: custom_resources.PhysicalResourceId.of('seed-produtos-v1'),
      },
      policy: custom_resources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.produtos.tableArn],
      }),
      installLatestAwsSdk: false,
      logGroup: seedLogGroup,
    });
  }
}
