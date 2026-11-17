
import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand
} from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({})
);

type RegistrarIntencaoEvent = {
  produto_id?: string;
  quantidade?: number;
  // Apenas para teste direto da Lambda.
  // Em produção, a identidade virá do Cognito.
  usuario_id?: string;
};

export const handler = async (
  event: RegistrarIntencaoEvent = {}
) => {
  const catalogTable = process.env.CATALOG_TABLE;
  const usersTable = process.env.USERS_TABLE;
  const intentionsTable = process.env.INTENTIONS_TABLE;

  if (!catalogTable || !usersTable || !intentionsTable) {
    throw new Error("Variáveis de ambiente não configuradas");
  }

  const { produto_id, quantidade, usuario_id } = event;

  if (
    !produto_id ||
    !usuario_id ||
    !Number.isSafeInteger(quantidade) ||
    quantidade! <= 0
  ) {
    return {
      sucesso: false,
      erro: "DADOS_INVALIDOS",
      mensagem: "Informe produto_id, quantidade válida e usuario_id"
    };
  }

  const produtoResponse = await db.send(
    new GetCommand({
      TableName: catalogTable,
      Key: { id: produto_id }
    })
  );

  const produto = produtoResponse.Item;

  if (!produto) {
    return {
      sucesso: false,
      erro: "PRODUTO_NAO_ENCONTRADO"
    };
  }

  if (
    !Number.isSafeInteger(produto.estoque) ||
    produto.estoque < quantidade!
  ) {
    return {
      sucesso: false,
      erro: "ESTOQUE_INSUFICIENTE"
    };
  }

  const usuarioResponse = await db.send(
    new GetCommand({
      TableName: usersTable,
      Key: { id: usuario_id }
    })
  );

  const usuario = usuarioResponse.Item;

  if (!usuario) {
    return {
      sucesso: false,
      erro: "USUARIO_NAO_ENCONTRADO"
    };
  }

  // O catálogo atual armazena preços em reais.
  // Convertemos para centavos antes dos cálculos.
  const precoCentavos = Math.round(
    Number(produto.preco) * 100
  );

  const valorTotalCentavos = precoCentavos * quantidade!;

  if (
    !Number.isSafeInteger(precoCentavos) ||
    precoCentavos <= 0 ||
    !Number.isSafeInteger(valorTotalCentavos)
  ) {
    return {
      sucesso: false,
      erro: "VALOR_INVALIDO"
    };
  }

  // Usuários de teste devem possuir limite_centavos.
  if (
    !Number.isSafeInteger(usuario.limite_centavos) ||
    usuario.limite_centavos < valorTotalCentavos
  ) {
    return {
      sucesso: false,
      erro: "LIMITE_EXCEDIDO"
    };
  }

  const agora = Date.now();
  const expiraEm = agora + 5 * 60 * 1000;
  const intencaoId = `int_${randomUUID()}`;

  const intencao = {
    id: intencaoId,
    usuario_id,
    produto_id,
    quantidade,
    preco_unitario_centavos: precoCentavos,
    valor_total_centavos: valorTotalCentavos,
    status: "PENDENTE",
    criado_em: new Date(agora).toISOString(),
    expira_em: new Date(expiraEm).toISOString(),
    ttl: Math.floor(expiraEm / 1000)
  };

  await db.send(
    new PutCommand({
      TableName: intentionsTable,
      Item: intencao,
      ConditionExpression: "attribute_not_exists(id)"
    })
  );

  return {
    sucesso: true,
    intencao_id: intencaoId,
    produto: produto.nome,
    quantidade,
    valor_total: valorTotalCentavos / 100,
    status: "PENDENTE",
    expira_em: intencao.expira_em
  };
};
