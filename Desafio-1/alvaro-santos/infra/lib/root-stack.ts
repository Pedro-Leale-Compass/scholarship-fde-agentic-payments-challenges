import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PaymentsDatabase } from './database';
import { Auth } from './auth';
import { FrontendHost } from './frontend-host';
import { ChatApi } from './api';
import { PaymentTools } from './tools';
import { PaymentAgent } from './agent';

export interface AgenticPaymentsStackProps extends cdk.StackProps {
  /**
   * Prefixo obrigatório para isolamento em conta compartilhada (us-east-1).
   */
  readonly resourcePrefix: string;
  /**
   * Quando true (ou contexto CDK -c skipFrontendHost=true), omite S3 + CloudFront
   * e libera o CORS da API para a origem local (contorno temporário ao bloqueio cloudfront:*).
   */
  readonly skipFrontendHost?: boolean;
  /**
   * Origem CORS usada quando skipFrontendHost está ativo (padrão: http://localhost:5173).
   */
  readonly localFrontendOrigin?: string;
}

/**
 * Stack principal do Desafio 1 (AWS Cloud) - Trilha AWS AI FDE (Pagamentos Agênticos)
 *
 * Responsável por orquestrar os recursos serverless do ecossistema Nexus Store:
 * - Autenticação fechada via Amazon Cognito (User Pool + Client PKCE)
 * - Persistência atômica e financeira via Amazon DynamoDB
 * - Funções AWS Lambda de tools MCP (consultar-saldo, criar-intencao, confirmar-pagamento)
 * - Agente Strands no Amazon Bedrock AgentCore Runtime
 * - API de streaming NDJSON via Amazon API Gateway
 * - Hospedagem estática segura via Amazon S3 privado + CloudFront com OAC (opcional via contexto)
 */
export class AgenticPaymentsStack extends cdk.Stack {
  public readonly database: PaymentsDatabase;
  public readonly auth: Auth;
  public readonly frontendHost?: FrontendHost;
  public readonly chatApi: ChatApi;
  public readonly paymentTools: PaymentTools;
  public readonly paymentAgent: PaymentAgent;

  constructor(scope: Construct, id: string, props: AgenticPaymentsStackProps) {
    super(scope, id, props);

    // Validação estrita do prefixo de governança
    if (!props.resourcePrefix.startsWith('alvaro-')) {
      throw new Error(`Violação de governança: o prefixo deve iniciar com 'alvaro-'. Recebido: ${props.resourcePrefix}`);
    }

    const skipContext = this.node.tryGetContext('skipFrontendHost');
    const skipFrontendHost =
      props.skipFrontendHost ??
      (skipContext === true || skipContext === 'true' || skipContext === '1');
    const localFrontendOrigin =
      props.localFrontendOrigin ??
      (this.node.tryGetContext('localFrontendOrigin') as string | undefined) ??
      'http://localhost:5173';

    // Camada de Persistência (Amazon DynamoDB)
    this.database = new PaymentsDatabase(this, 'Database', {
      resourcePrefix: props.resourcePrefix,
    });

    // Camada de Identidade e Autenticação (Amazon Cognito)
    this.auth = new Auth(this, 'Auth', {
      resourcePrefix: props.resourcePrefix,
    });

    // Camada de Borda Estática (Amazon S3 Privado + CloudFront OAC)
    // Pode ser omitida temporariamente via -c skipFrontendHost=true caso cloudfront:* esteja bloqueado.
    let allowedOrigin = localFrontendOrigin;
    if (!skipFrontendHost) {
      this.frontendHost = new FrontendHost(this, 'FrontendHost', {
        resourcePrefix: props.resourcePrefix,
        accountId: this.account,
      });
      allowedOrigin = `https://${this.frontendHost.distribution.distributionDomainName}`;
    }

    // Camada de Ferramentas Determinísticas (Lambdas de Tools)
    this.paymentTools = new PaymentTools(this, 'PaymentTools', {
      resourcePrefix: props.resourcePrefix,
      usuariosTable: this.database.usuariosTable,
      intencoesTable: this.database.intencoesTable,
    });

    // Runtime do Agente Strands (Bedrock AgentCore + Claude Haiku)
    this.paymentAgent = new PaymentAgent(this, 'PaymentAgent', {
      resourcePrefix: props.resourcePrefix,
      consultarSaldoLambda: this.paymentTools.consultarSaldoLambda,
      criarIntencaoLambda: this.paymentTools.criarIntencaoLambda,
      confirmarPagamentoLambda: this.paymentTools.confirmarPagamentoLambda,
    });

    // Camada de Borda da API (API Gateway REST + Streaming + JWT Authorizer)
    this.chatApi = new ChatApi(this, 'ChatApi', {
      resourcePrefix: props.resourcePrefix,
      userPool: this.auth.userPool,
      allowedOrigin,
      conversasTable: this.database.conversasTable,
      agentRuntime: this.paymentAgent.runtime,
    });

    // Outputs para governança e auditoria de CORS efetivo
    new cdk.CfnOutput(this, 'AllowedCorsOriginOutput', {
      value: allowedOrigin,
      description: 'Origem CORS configurada no Amazon API Gateway (CloudFront ou localhost temporário)',
      exportName: `${props.resourcePrefix}allowed-cors-origin`,
    });

    new cdk.CfnOutput(this, 'ResourcePrefixOutput', {
      value: props.resourcePrefix,
      description: 'Prefixo de isolamento de governança dos recursos na conta compartilhada',
      exportName: `${props.resourcePrefix}governance-prefix`,
    });
  }
}
