import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface DatabaseStackProps {
  stackPrefix: string;
}

export class DatabaseStack extends Construct {
  public readonly usuariosTable: dynamodb.Table;
  public readonly conversasTable: dynamodb.Table;
  public readonly intencoesTable: dynamodb.Table;
  public readonly catalogoTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id);

    const { stackPrefix } = props;
    const prefix = `${stackPrefix}-`;

    this.usuariosTable = new dynamodb.Table(this, 'UsuariosTable', {
      tableName: `${prefix}usuarios`,
      partitionKey: { name: 'usuario_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });

    this.conversasTable = new dynamodb.Table(this, 'ConversasTable', {
      tableName: `${prefix}conversas`,
      partitionKey: { name: 'conversa_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'usuario_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.conversasTable.addGlobalSecondaryIndex({
      indexName: 'usuario_id-index',
      partitionKey: { name: 'usuario_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'conversa_id', type: dynamodb.AttributeType.STRING },
    });

    this.intencoesTable = new dynamodb.Table(this, 'IntencoesTable', {
      tableName: `${prefix}intencoes`,
      partitionKey: { name: 'intencao_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.intencoesTable.addGlobalSecondaryIndex({
      indexName: 'usuario_id-index',
      partitionKey: { name: 'usuario_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    this.catalogoTable = new dynamodb.Table(this, 'CatalogoTable', {
      tableName: `${prefix}catalogo`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
