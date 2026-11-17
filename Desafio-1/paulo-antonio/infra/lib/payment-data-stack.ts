import { CfnOutput, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class PaymentDataStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { prefix: string }) {
    super(scope, id, props);
    Tags.of(this).add('Project', 'agente-pagamentos-aws');
    Tags.of(this).add('Owner', props.prefix);
    const conversations = new Table(this, 'Conversations', {
      tableName: `${props.prefix}-pagamentos-conversas`,
      partitionKey: { name: 'userId', type: AttributeType.STRING },
      sortKey: { name: 'conversationId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST, removalPolicy: RemovalPolicy.DESTROY,
    });
    new CfnOutput(this, 'ConversationsTable', { value: conversations.tableName });
    for (const [name, suffix, key] of [['Users', 'usuarios', 'userId'], ['Intents', 'intencoes', 'id'], ['Transactions', 'transacoes', 'id']]) {
      const table = new Table(this, name, {
        tableName: `${props.prefix}-pagamentos-${suffix}`,
        partitionKey: { name: key, type: AttributeType.STRING },
        billingMode: BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      new CfnOutput(this, `${name}Table`, { value: table.tableName });
    }
  }
}
