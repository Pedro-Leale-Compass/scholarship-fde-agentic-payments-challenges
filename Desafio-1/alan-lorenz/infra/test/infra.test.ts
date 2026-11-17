import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';

describe('InfraStack DynamoDB tables', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new InfraStack(app, 'TestInfraStack'));

  test('creates the five backend tables with on-demand billing caps', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 5);
    template.allResourcesProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      OnDemandThroughput: {
        MaxReadRequestUnits: 5,
        MaxWriteRequestUnits: 5,
      },
    });
  });

  test('stores conversation messages under the authenticated user and conversation key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'AlanLorenz-Conversas',
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'messageKey', KeyType: 'RANGE' },
      ],
    });
  });

  test('uses the intention id as the transaction key to prevent duplicate payments', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'AlanLorenz-Transacoes',
      KeySchema: [{ AttributeName: 'intentionId', KeyType: 'HASH' }],
    });
  });

  test('allows user creation only by an administrator', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
      },
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }],
      },
    });
  });

  test('creates a public SRP client without OAuth redirects or a client secret', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      AllowedOAuthFlows: Match.absent(),
      CallbackURLs: Match.absent(),
    });
  });

  test('protects the streaming chat route with Cognito and localhost-only CORS', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    const preflightMethods = Object.values(
      template.findResources('AWS::ApiGateway::Method'),
    ).filter((method) => method.Properties.HttpMethod === 'OPTIONS');
    expect(preflightMethods.length).toBeGreaterThan(0);
    for (const method of preflightMethods) {
      expect(JSON.stringify(method)).toContain("'http://localhost:3000'");
    }

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      Integration: {
        Type: 'AWS_PROXY',
        IntegrationHttpMethod: 'POST',
        ResponseTransferMode: 'STREAM',
      },
    });
    for (const responseType of ['UNAUTHORIZED', 'ACCESS_DENIED']) {
      template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
        ResponseType: responseType,
        ResponseParameters: {
          'gatewayresponse.header.Access-Control-Allow-Origin':
            "'http://localhost:3000'",
          'gatewayresponse.header.Access-Control-Allow-Headers':
            "'Authorization,Content-Type,X-Conversa-Id'",
          'gatewayresponse.header.Access-Control-Allow-Methods':
            "'POST,OPTIONS'",
          'gatewayresponse.header.Vary': "'Origin'",
        },
      });
    }

    const gatewayErrorResponses = Object.values(
      template.findResources('AWS::ApiGateway::GatewayResponse'),
    );
    for (const response of gatewayErrorResponses) {
      const origin =
        response.Properties.ResponseParameters[
          'gatewayresponse.header.Access-Control-Allow-Origin'
        ];
      expect(origin).toBe("'http://localhost:3000'");
    }
  });

  test('does not provision S3 or CloudFront for the local frontend', () => {
    template.resourceCountIs('AWS::S3::Bucket', 0);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    template.resourceCountIs('Custom::CDKBucketDeployment', 0);
  });

  test('deploys the Python 3.13 AgentCore CodeZip with the existing Haiku model', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'AlanLorenzChatAgent',
      AgentRuntimeArtifact: {
        CodeConfiguration: {
          Code: {
            S3: {
              Bucket: Match.anyValue(),
              Prefix: Match.anyValue(),
            },
          },
          EntryPoint: ['main.py'],
          Runtime: 'PYTHON_3_13',
        },
      },
      EnvironmentVariables: {
        BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        LIST_CATALOG_FUNCTION: Match.anyValue(),
        REGISTER_INTENTION_FUNCTION: Match.anyValue(),
        REALIZAR_COMPRA_FUNCTION: Match.anyValue(),
      },
    });
  });

  test('limits runtime model access and invokes only the three payment tools', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: Match.stringLikeRegexp('ChatAgentRuntimeExecutionRole'),
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            Resource: Match.anyValue(),
          }),
          Match.objectLike({
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            Condition: {
              StringLike: {
                'bedrock:InferenceProfileArn': Match.anyValue(),
              },
            },
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: Match.stringLikeRegexp('ChatAgentRuntimeExecutionRole'),
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
    const synthesized = JSON.stringify(template.toJSON().Resources);
    expect(synthesized).toContain(
      'inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
    expect(synthesized).toContain(
      'foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
    );
    const modelPolicy = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ).find((policy) =>
      policy.Properties.PolicyName?.includes('ChatAgentRuntimeExecutionRole'),
    );
    const modelStatement = modelPolicy?.Properties.PolicyDocument.Statement.find(
      (statement: Record<string, unknown>) =>
        JSON.stringify(statement.Condition ?? {}).includes(
          'InferenceProfileArn',
        ) &&
        Array.isArray(statement.Resource),
    );
    expect(modelStatement?.Resource).toHaveLength(3);
    const modelResourceArns = JSON.stringify(modelStatement?.Resource);
    for (const region of ['us-east-1', 'us-east-2', 'us-west-2']) {
      expect(modelResourceArns).toContain(
        `:bedrock:${region}::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
      );
    }
    expect(modelResourceArns).not.toContain('us-*');
  });

  test('retains the chat logs for one week and scopes the role to that log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/AlanLorenz-ChatHandler',
      RetentionInDays: 7,
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          }),
        ]),
      },
    });
  });

  test('creates the chat and three payment tool Lambdas with table names configured', () => {
    template.resourceCountIs('AWS::Lambda::Function', 4);
    for (const functionName of [
      'AlanLorenz-ListCatalog',
      'AlanLorenz-RegisterIntention',
      'AlanLorenz-RealizarCompra',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: functionName,
        Runtime: 'nodejs22.x',
        Environment: {
          Variables: {
            PRODUCTS_TABLE: Match.anyValue(),
            USERS_TABLE: Match.anyValue(),
            INTENTIONS_TABLE: Match.anyValue(),
            TRANSACTIONS_TABLE: Match.anyValue(),
          },
        },
      });
    }
  });

  test('configures the chat Lambda to invoke AgentCore with scoped IAM permission', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AlanLorenz-ChatHandler',
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: {
          AGENT_RUNTIME_ARN: Match.anyValue(),
          CONVERSATIONS_TABLE: Match.anyValue(),
          USERS_TABLE: Match.anyValue(),
          FRONTEND_ORIGIN: 'http://localhost:3000',
        },
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock-agentcore:InvokeAgentRuntime',
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
  });

  test('grants only the chat Lambda write access to the conversations table', () => {
    const conversationPolicies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ).filter((resource) =>
      JSON.stringify(resource.Properties.PolicyDocument).includes(
        'ConversationsTable',
      ),
    );
    expect(conversationPolicies).toHaveLength(1);
    expect(conversationPolicies[0]?.Properties.Roles).toEqual([
      { Ref: expect.stringMatching(/ChatHandlerRole/) },
    ]);
    const conversationStatements =
      conversationPolicies[0]?.Properties.PolicyDocument.Statement.filter(
        (statement: Record<string, unknown>) =>
          JSON.stringify(statement.Resource).includes('ConversationsTable'),
      );
    expect(conversationStatements).toEqual([
      {
        Action: 'dynamodb:PutItem',
        Effect: 'Allow',
        Resource: {
          'Fn::GetAtt': [
            expect.stringMatching(/ConversationsTable/),
            'Arn',
          ],
        },
      },
    ]);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['dynamodb:GetItem', 'dynamodb:PutItem'],
            Resource: {
              'Fn::GetAtt': [
                Match.stringLikeRegexp('UsersTable'),
                'Arn',
              ],
            },
          }),
        ]),
      },
    });

    const toolFunctions = Object.values(
      template.findResources('AWS::Lambda::Function'),
    );
    for (const functionName of [
      'AlanLorenz-ListCatalog',
      'AlanLorenz-RegisterIntention',
      'AlanLorenz-RealizarCompra',
    ]) {
      const toolFunction = toolFunctions.find(
        (resource) => resource.Properties.FunctionName === functionName,
      );
      expect(toolFunction).toBeDefined();
      expect(
        toolFunction?.Properties.Environment.Variables,
      ).not.toHaveProperty('CONVERSATIONS_TABLE');
    }
  });

  test('grants DynamoDB tool access through resource-scoped policies', () => {
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    );
    const statements = policies.flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const hasAction = (action: string) =>
      statements.some((statement) => {
        const value = statement.Action;
        const actions = Array.isArray(value) ? value : [value];
        return actions.includes(action);
      });

    expect(hasAction('dynamodb:TransactWriteItems')).toBe(true);
    expect(hasAction('dynamodb:Scan')).toBe(true);
  });

  test('does not synthesize IAM statements with an unscoped wildcard resource', () => {
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    );
    for (const policy of policies) {
      const statements = policy.Properties.PolicyDocument.Statement;
      expect(
        statements.filter(
          (statement: Record<string, unknown>) => statement.Resource === '*',
        ),
      ).toHaveLength(0);
    }

    const roles = Object.values(template.findResources('AWS::IAM::Role'));
    for (const role of roles) {
      expect(role.Properties.ManagedPolicyArns ?? []).not.toContain(
        Match.stringLikeRegexp('AWSLambdaBasicExecutionRole'),
      );
    }
  });
});
