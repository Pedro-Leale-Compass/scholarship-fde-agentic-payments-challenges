const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { FoundationStack } = require('../build/infra/lib/foundation-stack.js');
const { deploymentSynthesizer } = require('../build/infra/lib/deployment-synthesizer.js');

function template(backendOnly = false) {
  return Template.fromStack(new FoundationStack(new App(), 'TestFoundation', {
    prefix: 'teste-paulo', env: { account: '111111111111', region: 'us-east-1' },
    synthesizer: deploymentSynthesizer('teste-paulo'),
    backendOnly,
  }));
}

test('frontend privado com OAC, HTTPS e configuração sem cache', () => {
  const t = template();
  t.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    }, WebsiteConfiguration: Match.absent(),
  });
  t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: 'index.html',
      DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      Origins: Match.arrayWith([Match.objectLike({ OriginAccessControlId: Match.anyValue() })]),
    }),
  });
  const policies = t.findResources('AWS::S3::BucketPolicy');
  const allows = Object.values(policies).flatMap(p => p.Properties.PolicyDocument.Statement).filter(s => s.Effect === 'Allow');
  assert.ok(allows.length);
  for (const statement of allows) {
    assert.deepEqual(statement.Principal, { Service: 'cloudfront.amazonaws.com' });
    assert.ok(statement.Condition?.StringEquals?.['AWS:SourceArn']);
  }
});

test('backend isolado mantém autenticação e restringe CORS à interface local', () => {
  const t = template(true);
  t.resourceCountIs('AWS::CloudFront::Distribution', 0);
  t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 0);
  t.resourceCountIs('AWS::S3::Bucket', 0);
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { FRONTEND_ORIGIN: 'http://127.0.0.1:4173' } },
  });
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', { GenerateSecret: false });
  t.hasResourceProperties('AWS::ApiGateway::Authorizer', { Type: 'COGNITO_USER_POOLS', IdentityValidationExpression: Match.anyValue() });
  for (const method of Object.values(t.findResources('AWS::ApiGateway::Method'))) {
    if (method.Properties.HttpMethod !== 'OPTIONS') assert.equal(method.Properties.AuthorizationType, 'COGNITO_USER_POOLS');
    else assert.equal(method.Properties.Integration.IntegrationResponses[0].ResponseParameters['method.response.header.Access-Control-Allow-Origin'], "'http://127.0.0.1:4173'");
  }
  for (const response of Object.values(t.findResources('AWS::ApiGateway::GatewayResponse'))) {
    assert.equal(response.Properties.ResponseParameters['gatewayresponse.header.Access-Control-Allow-Origin'], "'http://127.0.0.1:4173'");
  }
});

test('deploy usa bucket privado próprio sem criar roles administrativas de bootstrap', () => {
  const prepared = require('../deployment-assets.json');
  assert.deepEqual(Object.values(prepared.Resources).map(r => r.Type).sort(), ['AWS::S3::Bucket', 'AWS::S3::BucketPolicy']);
  assert.deepEqual(prepared.Resources.AssetsBucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
  });
  const t = template().toJSON();
  assert.equal(t.Parameters?.BootstrapVersion, undefined);
  const functions = Object.values(t.Resources).filter(r => r.Type === 'AWS::Lambda::Function');
  assert.equal(functions[0].Properties.Code.S3Bucket, 'teste-paulo-assets-111111111111-us-east-1');
});

test('Cognito somente por convite e sem segredo de client; sessão exige autorizador', () => {
  const t = template();
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
  });
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', { GenerateSecret: false });
  t.hasResourceProperties('AWS::ApiGateway::Authorizer', {
    Type: 'COGNITO_USER_POOLS', IdentityValidationExpression: Match.anyValue(),
  });
  t.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'GET', AuthorizationType: 'COGNITO_USER_POOLS', AuthorizerId: Match.anyValue(),
  });
  t.hasResourceProperties('AWS::ApiGateway::GatewayResponse', { ResponseType: 'UNAUTHORIZED', StatusCode: '401' });
  const methods = Object.values(t.findResources('AWS::ApiGateway::Method'));
  for (const method of methods) {
    if (method.Properties.HttpMethod !== 'OPTIONS') assert.equal(method.Properties.AuthorizationType, 'COGNITO_USER_POOLS');
  }
});

test('role da sessão somente escreve logs; não há política administrativa', () => {
  const t = template();
  for (const role of Object.values(t.findResources('AWS::IAM::Role'))) {
    assert.equal(role.Properties.ManagedPolicyArns, undefined);
  }
  const policies = Object.entries(t.findResources('AWS::IAM::Policy'));
  const statements = policies.filter(([id]) => id.startsWith('SessionRole')).flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
  assert.ok(statements.length);
  for (const statement of statements) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    assert.ok(actions.every(a => ['logs:CreateLogStream', 'logs:PutLogEvents'].includes(a)));
    assert.notEqual(statement.Resource, '*');
  }
});

test('ferramentas acessam somente tabelas próprias, sem scan/delete nem privilégios administrativos', () => {
  const t = template(true);
  t.resourceCountIs('AWS::Lambda::Function', 4);
  const policies = Object.entries(t.findResources('AWS::IAM::Policy')).filter(([id]) => id.startsWith('PaymentRole'));
  const statements = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
  const data = statements.filter(s => JSON.stringify(s.Action).includes('dynamodb:'));
  assert.equal(data.length, 3);
  for (const statement of data) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    assert.ok(actions.every(a => ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'].includes(a)));
    assert.match(JSON.stringify(statement.Resource), /table\/teste-paulo-pagamentos-/);
    assert.ok(!JSON.stringify(statement.Resource).includes('*'));
  }
  const protectedMethods = Object.values(t.findResources('AWS::ApiGateway::Method')).filter(m => m.Properties.HttpMethod !== 'OPTIONS');
  assert.equal(protectedMethods.length, 8);
  assert.ok(protectedMethods.every(m => m.Properties.AuthorizationType === 'COGNITO_USER_POOLS'));
});

test('chat transmite respostas e delega ao AgentCore sem acesso a pagamentos ou modelo', () => {
  const t = template(true);
  t.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
  t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    AgentRuntimeArtifact: { CodeConfiguration: Match.objectLike({ Runtime: 'NODE_22', EntryPoint: ['index.js'] }) },
    NetworkConfiguration: { NetworkMode: 'PUBLIC' }, AuthorizerConfiguration: Match.absent(),
  });
  t.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'POST', AuthorizationType: 'COGNITO_USER_POOLS',
    Integration: Match.objectLike({ Type: 'AWS_PROXY', ResponseTransferMode: 'STREAM' }) });
  const policies = Object.entries(t.findResources('AWS::IAM::Policy'));
  const agent = policies.filter(([id]) => id.startsWith('AgentRole')).flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
  assert.ok(agent.some(s => JSON.stringify(s.Action).includes('bedrock:InvokeModel')));
  assert.ok(!agent.some(s => JSON.stringify(s.Action).includes('dynamodb:')));
  const chat = policies.filter(([id]) => id.startsWith('chatRole')).flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
  assert.ok(chat.some(s => JSON.stringify(s.Action).includes('bedrock-agentcore:InvokeAgentRuntime')));
  assert.ok(!chat.some(s => /bedrock:|lambda:/.test(JSON.stringify(s.Action))));
  for (const s of chat.filter(s => JSON.stringify(s.Action).includes('dynamodb:'))) {
    assert.match(JSON.stringify(s.Resource), /pagamentos-conversas/);
  }
});
