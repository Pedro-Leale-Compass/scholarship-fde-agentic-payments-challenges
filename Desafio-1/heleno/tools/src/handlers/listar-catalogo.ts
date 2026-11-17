
import {
  DynamoDBClient
} from "@aws-sdk/client-dynamodb";

import {
  DynamoDBDocumentClient,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({})
);

export const handler = async (
  event: { categoria?: string } = {}
) => {
  const tableName = process.env.CATALOG_TABLE;

  if (!tableName) {
    throw new Error("CATALOG_TABLE não configurada");
  }

  const response = await client.send(
    new ScanCommand({
      TableName: tableName
    })
  );

  const produtos = response.Items ?? [];

  const resultado = event.categoria
    ? produtos.filter(
        p => p.categoria === event.categoria
      )
    : produtos;

  return {
    sucesso: true,
    produtos: resultado
  };
};
