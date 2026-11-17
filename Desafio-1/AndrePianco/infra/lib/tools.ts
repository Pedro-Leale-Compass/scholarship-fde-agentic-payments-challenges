import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { Dados } from "./dados";

const RAIZ = path.join(__dirname, "../..");

/**
 * Uma Lambda por tool. Cada uma recebe permissao SO nas tabelas e SO nas
 * acoes que usa (nada de grantReadWriteData generico nem "*").
 */
export class Tools extends Construct {
  readonly listarCatalogo: lambda.Function;
  readonly registrarIntencao: lambda.Function;
  readonly realizarCompra: lambda.Function;

  constructor(scope: Construct, id: string, props: { dados: Dados; ttlIntencaoSegundos: number }) {
    super(scope, id);
    const { dados } = props;

    const criar = (nome: string, arquivo: string, environment: Record<string, string>) => {
      const logGroup = new logs.LogGroup(this, `${nome}Logs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      return new nodejs.NodejsFunction(this, nome, {
        entry: path.join(RAIZ, "tools/src", arquivo),
        projectRoot: RAIZ,
        depsLockFilePath: path.join(RAIZ, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        environment,
        logGroup,
        bundling: { minify: true, sourceMap: false, target: "node22" },
      });
    };

    // listar_catalogo: so LE o catalogo.
    this.listarCatalogo = criar("ListarCatalogo", "listar-catalogo.ts", {
      TABELA_CATALOGO: dados.catalogo.tableName,
    });
    dados.catalogo.grant(this.listarCatalogo, "dynamodb:Scan");

    // registrar_intencao: le um produto, grava uma intencao nova.
    this.registrarIntencao = criar("RegistrarIntencao", "registrar-intencao.ts", {
      TABELA_CATALOGO: dados.catalogo.tableName,
      TABELA_INTENCOES: dados.intencoes.tableName,
      INTENCAO_TTL_SEGUNDOS: String(props.ttlIntencaoSegundos),
    });
    dados.catalogo.grant(this.registrarIntencao, "dynamodb:GetItem");
    dados.intencoes.grant(this.registrarIntencao, "dynamodb:PutItem");

    // realizar_compra: transacao sobre intencao, limite, estoque e transacao.
    this.realizarCompra = criar("RealizarCompra", "realizar-compra.ts", {
      TABELA_CATALOGO: dados.catalogo.tableName,
      TABELA_USUARIOS: dados.usuarios.tableName,
      TABELA_INTENCOES: dados.intencoes.tableName,
      TABELA_TRANSACOES: dados.transacoes.tableName,
    });
    dados.intencoes.grant(this.realizarCompra, "dynamodb:GetItem", "dynamodb:UpdateItem");
    dados.usuarios.grant(this.realizarCompra, "dynamodb:GetItem", "dynamodb:UpdateItem");
    dados.catalogo.grant(this.realizarCompra, "dynamodb:UpdateItem");
    dados.transacoes.grant(this.realizarCompra, "dynamodb:PutItem");
  }
}
