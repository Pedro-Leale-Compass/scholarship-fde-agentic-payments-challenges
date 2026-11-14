import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DadosConstruct } from './constructs/dados';
import { AutenticacaoConstruct } from './constructs/autenticacao';

export class DesafioStack extends cdk.Stack {
  public readonly dados: DadosConstruct;
  public readonly autenticacao: AutenticacaoConstruct;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // 1. Dados (Tabelas DynamoDB e Seed de Produtos)
    // =========================================================================
    this.dados = new DadosConstruct(this, 'Dados');

    new cdk.CfnOutput(this, 'ProdutosTableName', {
      value: this.dados.produtos.tableName,
      description: 'Nome da tabela de produtos',
    });
    new cdk.CfnOutput(this, 'UsuariosTableName', {
      value: this.dados.usuarios.tableName,
      description: 'Nome da tabela de usuarios',
    });
    new cdk.CfnOutput(this, 'IntencoesTableName', {
      value: this.dados.intencoes.tableName,
      description: 'Nome da tabela de intencoes',
    });
    new cdk.CfnOutput(this, 'TransacoesTableName', {
      value: this.dados.transacoes.tableName,
      description: 'Nome da tabela de transacoes',
    });
    new cdk.CfnOutput(this, 'ConversasTableName', {
      value: this.dados.conversas.tableName,
      description: 'Nome da tabela de conversas',
    });

    // =========================================================================
    // 2. Autenticação (Cognito User Pool e Client)
    // =========================================================================
    this.autenticacao = new AutenticacaoConstruct(this, 'Autenticacao');

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.autenticacao.userPool.userPoolId,
      description: 'ID do User Pool do Cognito',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.autenticacao.client.userPoolClientId,
      description: 'ID do Client Web do Cognito',
    });
  }
}
