import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { bundleNode22Lambda } from './lambda-bundler';

export interface PaymentToolsProps {
  /**
   * Prefixo obrigatório para isolamento em conta compartilhada (ex: 'alvaro-').
   */
  readonly resourcePrefix: string;
  /**
   * Tabela de usuários (`alvaro-usuarios`) usada para leitura de saldo/limite.
   */
  readonly usuariosTable: dynamodb.ITable;
  /**
   * Tabela de intenções (`alvaro-intencoes`) usada para registrar intenções PENDENTE.
   */
  readonly intencoesTable: dynamodb.ITable;
}

/**
 * Construto das Lambdas de Ferramentas MCP/Agênticas (Épico 03).
 *
 * Princípio de menor privilégio: cada Lambda recebe apenas a permissão exata
 * necessária na tabela que manipula, sem acesso a outras tabelas ou ao Bedrock.
 */
export class PaymentTools extends Construct {
  public readonly consultarSaldoLambda: lambda.Function;
  public readonly criarIntencaoLambda: lambda.Function;
  public readonly confirmarPagamentoLambda: lambda.Function;

  constructor(scope: Construct, id: string, props: PaymentToolsProps) {
    super(scope, id);

    const { resourcePrefix, usuariosTable, intencoesTable } = props;
    const toolsDir = path.join(__dirname, '../../tools');

    // TOOL-01: Consulta de Catálogo e Saldo do usuário autenticado
    this.consultarSaldoLambda = new lambda.Function(this, 'ConsultarSaldoHandler', {
      functionName: `${resourcePrefix}tool-consultar-saldo`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      code: bundleNode22Lambda(path.join(toolsDir, 'consultar-saldo/index.ts'), toolsDir),
      environment: {
        USUARIOS_TABLE_NAME: usuariosTable.tableName,
      },
    });

    // Menor privilégio estrito: somente dynamodb:GetItem na tabela alvaro-usuarios.
    usuariosTable.grant(this.consultarSaldoLambda, 'dynamodb:GetItem');

    // TOOL-02: Registro de Intenção de Compra (sem movimentação de saldo)
    this.criarIntencaoLambda = new lambda.Function(this, 'CriarIntencaoHandler', {
      functionName: `${resourcePrefix}tool-criar-intencao`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      code: bundleNode22Lambda(path.join(toolsDir, 'criar-intencao/index.ts'), toolsDir),
      environment: {
        INTENCOES_TABLE_NAME: intencoesTable.tableName,
      },
    });

    // Menor privilégio estrito: somente dynamodb:PutItem na tabela alvaro-intencoes.
    intencoesTable.grant(this.criarIntencaoLambda, 'dynamodb:PutItem');

    // TOOL-03: Liquidação Atômica e Idempotente de Pagamento
    this.confirmarPagamentoLambda = new lambda.Function(this, 'ConfirmarPagamentoHandler', {
      functionName: `${resourcePrefix}tool-confirmar-pagamento`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      code: bundleNode22Lambda(path.join(toolsDir, 'confirmar-pagamento/index.ts'), toolsDir),
      environment: {
        USUARIOS_TABLE_NAME: usuariosTable.tableName,
        INTENCOES_TABLE_NAME: intencoesTable.tableName,
      },
    });

    // Menor privilégio estrito: apenas leitura/atualização condicional em alvaro-intencoes e alvaro-usuarios.
    intencoesTable.grant(
      this.confirmarPagamentoLambda,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
      'dynamodb:ConditionCheckItem',
    );
    usuariosTable.grant(
      this.confirmarPagamentoLambda,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
      'dynamodb:ConditionCheckItem',
    );

    new cdk.CfnOutput(this, 'ConsultarSaldoLambdaArnOutput', {
      value: this.consultarSaldoLambda.functionArn,
      description: 'ARN da Lambda TOOL-01 (Consulta de Catálogo e Saldo)',
      exportName: `${resourcePrefix}tool-consultar-saldo-arn`,
    });

    new cdk.CfnOutput(this, 'CriarIntencaoLambdaArnOutput', {
      value: this.criarIntencaoLambda.functionArn,
      description: 'ARN da Lambda TOOL-02 (Registro de Intenção de Compra)',
      exportName: `${resourcePrefix}tool-criar-intencao-arn`,
    });

    new cdk.CfnOutput(this, 'ConfirmarPagamentoLambdaArnOutput', {
      value: this.confirmarPagamentoLambda.functionArn,
      description: 'ARN da Lambda TOOL-03 (Liquidação Atômica e Idempotente)',
      exportName: `${resourcePrefix}tool-confirmar-pagamento-arn`,
    });
  }
}
