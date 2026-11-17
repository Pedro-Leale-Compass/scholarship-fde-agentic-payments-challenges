const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { PaymentDataStack } = require('../build/infra/lib/payment-data-stack.js');

test('pagamentos e conversas usam quatro tabelas sob demanda sem exposição por API', () => {
  const template = Template.fromStack(new PaymentDataStack(new App(), 'DataTest', {
    prefix: 'teste-paulo', env: { account: '111111111111', region: 'us-east-1' },
  }));
  template.resourceCountIs('AWS::DynamoDB::Table', 4);
  template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'teste-paulo-pagamentos-conversas', KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'conversationId', KeyType: 'RANGE' }] });
  template.resourceCountIs('AWS::IAM::Policy', 0);
  template.resourceCountIs('AWS::ApiGateway::Method', 0);
  for (const table of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
    assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST');
    assert.equal(table.Properties.TimeToLiveSpecification, undefined);
    assert.equal(table.DeletionPolicy, 'Delete');
  }
});
