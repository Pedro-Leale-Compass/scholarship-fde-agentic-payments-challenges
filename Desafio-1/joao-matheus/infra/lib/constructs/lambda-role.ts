import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { nome } from '../config';

export interface CriarFuncaoComRoleProps {
  nomeFuncao: string;
  descricao?: string;
  runtime?: lambda.Runtime;
  architecture?: lambda.Architecture;
  handler: string;
  code: lambda.Code;
  timeout?: cdk.Duration;
  memorySize?: number;
  environment?: { [key: string]: string };
  initialPolicy?: iam.PolicyStatement[];
}

export function criarFuncaoComRole(
  scope: Construct,
  id: string,
  props: CriarFuncaoComRoleProps
): { funcao: lambda.Function; role: iam.Role; logGroup: logs.LogGroup } {
  const nomeCompleto = nome(props.nomeFuncao);

  // 1. Log Group explícito com retenção de 1 semana e remoção no destroy
  const logGroup = new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${nomeCompleto}`,
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  // 2. Role IAM dedicada sem nenhuma AWS Managed Policy ampla
  const role = new iam.Role(scope, `${id}Role`, {
    roleName: `${nomeCompleto}-role`,
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `Role de menor privilégio para a função ${nomeCompleto}`,
  });

  // Permissão estrita de escrita nos logs do seu próprio log group
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'PermitirLogsProprioLogGroup',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        logGroup.logGroupArn,
        `${logGroup.logGroupArn}:*`,
      ],
    })
  );

  // Adicionar políticas iniciais específicas, se houver
  if (props.initialPolicy) {
    for (const stmt of props.initialPolicy) {
      role.addToPolicy(stmt);
    }
  }

  // 3. Função Lambda
  const funcao = new lambda.Function(scope, id, {
    functionName: nomeCompleto,
    description: props.descricao,
    runtime: props.runtime ?? lambda.Runtime.PYTHON_3_12,
    architecture: props.architecture ?? lambda.Architecture.ARM_64,
    handler: props.handler,
    code: props.code,
    timeout: props.timeout ?? cdk.Duration.seconds(10),
    memorySize: props.memorySize ?? 256,
    environment: props.environment,
    role: role,
    logGroup: logGroup,
  });

  return { funcao, role, logGroup };
}
