import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Agente } from "./agente";
import { Api } from "./api";
import { Dados } from "./dados";
import { Tools } from "./tools";

/**
 * Stack do backend: DynamoDB, Lambdas das tools, agente no AgentCore
 * Runtime, Cognito e API Gateway com a Lambda do chat.
 */
export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const dados = new Dados(this, "Dados");
    const tools = new Tools(this, "Tools", { dados, ttlIntencaoSegundos: 300 });
    // Padrao: Claude Haiku 4.5 (recomendado pelo desafio). Pode ser trocado
    // no deploy com `-c modelo=<inference profile>`, ex.: us.amazon.nova-lite-v1:0
    const modeloId =
      (this.node.tryGetContext("modelo") as string | undefined) ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    const agente = new Agente(this, "Agente", { modeloId, tools });

    // Origens do CORS: `-c origens=https://main.xxxx.amplifyapp.com,http://localhost:5173`
    const origens = String(this.node.tryGetContext("origens") ?? "http://localhost:5173")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const api = new Api(this, "Api", {
      dados,
      agenteRuntimeArn: agente.runtime.attrAgentRuntimeArn,
      origens,
      limitePadrao: Number(this.node.tryGetContext("limitePadrao") ?? 1000),
    });

    const saida = (nome: string, valor: string) => new cdk.CfnOutput(this, nome, { value: valor });
    saida("TabelaUsuarios", dados.usuarios.tableName);
    saida("TabelaCatalogo", dados.catalogo.tableName);
    saida("TabelaIntencoes", dados.intencoes.tableName);
    saida("TabelaTransacoes", dados.transacoes.tableName);
    saida("TabelaConversas", dados.conversas.tableName);
    saida("FnListarCatalogo", tools.listarCatalogo.functionName);
    saida("FnRegistrarIntencao", tools.registrarIntencao.functionName);
    saida("FnRealizarCompra", tools.realizarCompra.functionName);
    saida("AgenteRuntimeArn", agente.runtime.attrAgentRuntimeArn);
    saida("ApiUrl", api.restApi.url);
    saida("UserPoolId", api.userPool.userPoolId);
    saida("UserPoolClientId", api.client.userPoolClientId);
  }
}
