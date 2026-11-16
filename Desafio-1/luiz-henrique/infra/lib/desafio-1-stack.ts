import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { DatabaseStack } from './database-stack';
import { ToolsStack } from './tools-stack';
import { AgentStack } from './agent-stack';
import { ApiStack } from './api-stack';

export interface Desafio1StackProps extends cdk.StackProps {
  stackPrefix: string;
}

const CATALOGO = [
  { id: 'p1', nome: 'Fone Bluetooth', preco: 199.9 },
  { id: 'p2', nome: 'Teclado Mecânico', preco: 349.9 },
  { id: 'p3', nome: 'Mouse Gamer', preco: 129.9 },
  { id: 'p4', nome: 'Monitor 27"', preco: 1299.0 },
  { id: 'p5', nome: 'Webcam Full HD', preco: 299.0 },
  { id: 'p6', nome: 'Cadeira Gamer', preco: 1499.0 },
  { id: 'p7', nome: 'Headset com Microfone', preco: 249.9 },
  { id: 'p8', nome: 'Suporte para Monitor', preco: 149.0 },
];

export class Desafio1Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Desafio1StackProps) {
    super(scope, id);

    const { stackPrefix } = props;
    const prefix = `${stackPrefix}-`;

    // 1. DynamoDB tables (usuarios, conversas, intencoes, catalogo)
    const database = new DatabaseStack(this, 'DatabaseStack', { stackPrefix });

    // 2. Tool Lambdas: listar_catalogo, registrar_intencao, realizar_compra
    const tools = new ToolsStack(this, 'ToolsStack', {
      stackPrefix,
      intencoesTable: database.intencoesTable,
      usuariosTable: database.usuariosTable,
      catalogoTable: database.catalogoTable,
    });

    // 3. Agente Strands no AgentCore Runtime
    const agent = new AgentStack(this, 'AgentStack', {
      stackPrefix,
      toolLambdaArns: tools.toolLambdaArns,
    });

    // 4. URL do frontend (local:3000 em desenvolvimento; S3+CloudFront no futuro)
    const frontendUrl = 'http://localhost:3000';

    // 5. Cognito user pool + API Gateway + Lambda chat + JWT authorizer
    const api = new ApiStack(this, 'ApiStack', {
      stackPrefix,
      agentRuntimeArn: agent.agentRuntimeArn,
      usuariosTable: database.usuariosTable,
      frontendUrl,
    });

    // 6. Popula o catálogo (idempotente: PutItem com os mesmos ids)
    CATALOGO.forEach((produto, index) => {
      new customResources.AwsCustomResource(this, `SeedCatalogo${index}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: database.catalogoTable.tableName,
            Item: {
              id: { S: produto.id },
              nome: { S: produto.nome },
              preco: { N: String(produto.preco) },
            },
          },
          physicalResourceId: customResources.PhysicalResourceId.of(`catalogo-${produto.id}`),
        },
        policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [database.catalogoTable.tableArn],
        }),
      });
    });

    // 7. Cria o usuário do instrutor no Cognito (sem auto cadastro).
    //    Requer TEST_PASSWORD no ambiente do deploy (não fica no Git).
    const testEmail = process.env.TEST_EMAIL || '<test-email>';
    const testPassword = process.env.TEST_PASSWORD;

    if (testPassword) {
      const createUser = new customResources.AwsCustomResource(this, 'CreateTestUser', {
        onCreate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'adminCreateUser',
          parameters: {
            UserPoolId: api.userPool.userPoolId,
            Username: testEmail,
            UserAttributes: [
              { Name: 'email', Value: testEmail },
              { Name: 'email_verified', Value: 'true' },
            ],
            MessageAction: 'SUPPRESS',
          },
          physicalResourceId: customResources.PhysicalResourceId.of(`cognito-user-${testEmail}`),
          ignoreErrorCodesMatching: 'UsernameExistsException',
        },
        onUpdate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'adminCreateUser',
          parameters: {
            UserPoolId: api.userPool.userPoolId,
            Username: testEmail,
            UserAttributes: [
              { Name: 'email', Value: testEmail },
              { Name: 'email_verified', Value: 'true' },
            ],
            MessageAction: 'SUPPRESS',
          },
          physicalResourceId: customResources.PhysicalResourceId.of(`cognito-user-${testEmail}`),
          ignoreErrorCodesMatching: 'UsernameExistsException',
        },
        policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [api.userPool.userPoolArn],
        }),
      });

      new customResources.AwsCustomResource(this, 'SetTestPassword', {
        onCreate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'adminSetUserPassword',
          parameters: {
            UserPoolId: api.userPool.userPoolId,
            Username: testEmail,
            Password: testPassword,
            Permanent: true,
          },
          physicalResourceId: customResources.PhysicalResourceId.of(`cognito-password-${testEmail}`),
        },
        onUpdate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'adminSetUserPassword',
          parameters: {
            UserPoolId: api.userPool.userPoolId,
            Username: testEmail,
            Password: testPassword,
            Permanent: true,
          },
          physicalResourceId: customResources.PhysicalResourceId.of(`cognito-password-${testEmail}`),
        },
        policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [api.userPool.userPoolArn],
        }),
      }).node.addDependency(createUser);
    }

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiUrl, description: 'API Gateway URL' });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: api.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });
    new cdk.CfnOutput(this, 'CognitoUserPoolClientId', {
      value: api.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: agent.agentRuntimeArn,
      description: 'AgentCore Runtime ARN',
    });
    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: agent.ecrRepositoryUri,
      description: 'ECR repository URI for agent container image',
    });
  }
}
