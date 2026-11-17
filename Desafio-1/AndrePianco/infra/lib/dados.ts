import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

/**
 * Tabelas do DynamoDB. Todas sob demanda (paga por requisicao, custo ~zero
 * parado) e com RemovalPolicy.DESTROY para o `cdk destroy` limpar tudo.
 */
export class Dados extends Construct {
  readonly usuarios: dynamodb.Table;
  readonly catalogo: dynamodb.Table;
  readonly intencoes: dynamodb.Table;
  readonly transacoes: dynamodb.Table;
  readonly conversas: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const tabela = (nome: string, pk: string, sk?: string) =>
      new dynamodb.Table(this, nome, {
        partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
        ...(sk && { sortKey: { name: sk, type: dynamodb.AttributeType.STRING } }),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    /** user_id (sub do Cognito) -> nome, email, limite_total, limite_disponivel */
    this.usuarios = tabela("Usuarios", "user_id");
    /** id do produto -> nome, descricao, categoria, preco, moeda, estoque */
    this.catalogo = tabela("Catalogo", "id");
    /** intencao_id -> dono, produto, quantidade, valor_total, status, prazos */
    this.intencoes = tabela("Intencoes", "intencao_id");
    /** transacao_id -> compra aprovada (registro historico, so cresce) */
    this.transacoes = tabela("Transacoes", "transacao_id");
    /** user_id + sk (timestamp#seq) -> uma mensagem do historico */
    this.conversas = tabela("Conversas", "user_id", "sk");

    // Historico de compras por usuario (consulta pelo dono).
    this.transacoes.addGlobalSecondaryIndex({
      indexName: "por_usuario",
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "criada_em", type: dynamodb.AttributeType.STRING },
    });

    this.semearCatalogo();
  }

  /**
   * Carrega data/catalogo.seed.json na tabela de catalogo durante o deploy.
   * Roda de novo so quando o arquivo de seed mudar.
   */
  private semearCatalogo() {
    const caminho = path.join(__dirname, "../../data/catalogo.seed.json");
    const conteudo = fs.readFileSync(caminho, "utf8");
    const produtos: Array<Record<string, string | number>> = JSON.parse(conteudo);

    const paraDynamo = (p: Record<string, string | number>) =>
      Object.fromEntries(
        Object.entries(p).map(([k, v]) => [k, typeof v === "number" ? { N: String(v) } : { S: v }]),
      );

    const chamada: cr.AwsSdkCall = {
      service: "DynamoDB",
      action: "batchWriteItem",
      parameters: {
        RequestItems: {
          [this.catalogo.tableName]: produtos.map((p) => ({ PutRequest: { Item: paraDynamo(p) } })),
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of(
        `seed-catalogo-${crypto.createHash("sha256").update(conteudo).digest("hex").slice(0, 12)}`,
      ),
    };

    new cr.AwsCustomResource(this, "SeedCatalogo", {
      onCreate: chamada,
      onUpdate: chamada,
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.catalogo.tableArn] }),
      installLatestAwsSdk: false,
    });
  }
}
