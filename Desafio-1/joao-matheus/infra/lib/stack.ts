import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { FrontendHostingConstruct } from './constructs/frontend-hosting';
import { AutenticacaoConstruct } from './constructs/autenticacao';
import { DadosConstruct } from './constructs/dados';

export class DesafioStack extends cdk.Stack {
  public readonly frontendHosting: FrontendHostingConstruct;
  public readonly autenticacao: AutenticacaoConstruct;
  public readonly dados: DadosConstruct;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // 1. Frontend Hosting (S3 Privado + CloudFront com OAC)
    // =========================================================================
    this.frontendHosting = new FrontendHostingConstruct(this, 'FrontendHosting');

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: this.frontendHosting.urlFrontend,
      description: 'URL do frontend (CloudFront ou localhost durante desenvolvimento)',
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.frontendHosting.bucket.bucketName,
      description: 'Nome do bucket privado do frontend',
    });

    if (this.frontendHosting.distribution) {
      new cdk.CfnOutput(this, 'DistributionId', {
        value: this.frontendHosting.distribution.distributionId,
        description: 'ID da distribuição CloudFront',
      });
    }

    // =========================================================================
    // 2. Autenticação (Cognito User Pool e Client)
    // =========================================================================
    this.autenticacao = new AutenticacaoConstruct(this, 'Autenticacao', {
      urlFrontend: this.frontendHosting.urlFrontend,
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.autenticacao.userPool.userPoolId,
      description: 'ID do User Pool do Cognito',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.autenticacao.client.userPoolClientId,
      description: 'ID do Client Web do Cognito',
    });

    // =========================================================================
    // 3. Dados (Tabelas DynamoDB e Seed de Produtos)
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
  }
}
