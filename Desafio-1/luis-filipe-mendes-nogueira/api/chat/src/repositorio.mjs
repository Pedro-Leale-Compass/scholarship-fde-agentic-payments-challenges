import { createHash, randomUUID } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

export class ErroHttp extends Error {
  constructor(status, codigo, mensagem) {
    super(mensagem);
    this.name = "ErroHttp";
    this.status = status;
    this.codigo = codigo;
  }
}

export const tamanho = (valor) =>
  Buffer.byteLength(JSON.stringify(valor), "utf8");

const hash = (texto) =>
  createHash("sha256").update(texto, "utf8").digest("hex");

const numero = (valor) => String(valor).padStart(12, "0");

export class RepositorioConversas {
  constructor(cliente, tabela) {
    this.cliente = cliente;
    this.tabela = tabela;
  }

  chave(usuario, registro) {
    return {
      usuario_id: usuario,
      registro_id: registro,
    };
  }

  async ler(usuario, registro) {
    const resultado = await this.cliente.send(
      new GetCommand({
        TableName: this.tabela,
        Key: this.chave(usuario, registro),
        ConsistentRead: true,
      }),
    );

    return resultado.Item;
  }

  async consultar(usuario, inicio, fim) {
    const itens = [];
    let ultimaChave;

    do {
      const pagina = await this.cliente.send(
        new QueryCommand({
          TableName: this.tabela,
          KeyConditionExpression:
            "usuario_id = :usuario AND registro_id BETWEEN :inicio AND :fim",
          ExpressionAttributeValues: {
            ":usuario": usuario,
            ":inicio": inicio,
            ":fim": fim,
          },
          ConsistentRead: true,
          ExclusiveStartKey: ultimaChave,
        }),
      );

      itens.push(...(pagina.Items ?? []));
      ultimaChave = pagina.LastEvaluatedKey;
    } while (ultimaChave);

    return itens;
  }

  resumo(item) {
    return {
      conversa_id: item.conversa_id,
      estado: item.estado,
      versao: item.versao,
      criada_em: item.criada_em,
      atualizada_em: item.atualizada_em,
      requisicao_id: item.requisicao_id ?? null,
    };
  }

  async criar(usuario) {
    const agora = new Date().toISOString();
    const conversa = randomUUID();

    const item = {
      ...this.chave(usuario, `CONVERSA#${conversa}`),
      conversa_id: conversa,
      estado: "livre",
      versao: 0,
      criada_em: agora,
      atualizada_em: agora,
    };

    await this.cliente.send(
      new PutCommand({
        TableName: this.tabela,
        Item: item,
        ConditionExpression: "attribute_not_exists(registro_id)",
      }),
    );

    return this.resumo(item);
  }

  async listar(usuario) {
    const itens = await this.consultar(
      usuario,
      "CONVERSA#",
      "CONVERSA#\uffff",
    );

    return itens
      .map((item) => this.resumo(item))
      .sort((a, b) => b.atualizada_em.localeCompare(a.atualizada_em));
  }

  async obter(usuario, conversa) {
    const item = await this.ler(usuario, `CONVERSA#${conversa}`);

    if (!item) {
      throw new ErroHttp(
        404,
        "CONVERSA_INVALIDA",
        "Essa conversa não foi encontrada.",
      );
    }

    return this.resumo(item);
  }

  async historico(usuario, conversa) {
    if (conversa.versao === 0) return [];

    const prefixo = `TURNO#${conversa.conversa_id}#`;
    const turnos = await this.consultar(
      usuario,
      `${prefixo}${numero(1)}`,
      `${prefixo}${numero(conversa.versao)}`,
    );

    if (turnos.length !== conversa.versao) {
      throw new Error("Histórico persistido incompleto.");
    }

    const mensagens = turnos.flatMap((turno, indice) => {
      if (turno.versao !== indice + 1) {
        throw new Error("Sequência do histórico inválida.");
      }

      return JSON.parse(turno.mensagens_json);
    });

    if (tamanho(mensagens) > 1_000_000) {
      throw new ErroHttp(
        413,
        "HISTORICO_EXTENSO",
        "Esta conversa atingiu o limite de tamanho. Abra uma nova conversa.",
      );
    }

    return mensagens;
  }

  async requisicao(usuario, conversa, requisicao) {
    return this.ler(
      usuario,
      `REQUISICAO#${conversa}#${requisicao}`,
    );
  }

  verificarRepeticao(item, mensagem) {
    if (item.mensagem_hash !== hash(mensagem)) {
      throw new ErroHttp(
        409,
        "REQUISICAO_DIVERGENTE",
        "Esse identificador já foi usado para outra mensagem.",
      );
    }

    if (item.estado !== "concluida") {
      throw new ErroHttp(
        409,
        "REQUISICAO_EM_ANDAMENTO_OU_INCERTA",
        "Esta requisição já foi recebida. Consulte a conversa antes de tentar novamente.",
      );
    }

    return {
      repetida: true,
      requisicao: item,
    };
  }

  async iniciar(usuario, conversa, requisicao, mensagem, sessaoRuntime) {
    const existente = await this.requisicao(
      usuario,
      conversa.conversa_id,
      requisicao,
    );

    if (existente) {
      return this.verificarRepeticao(existente, mensagem);
    }

    if (conversa.estado !== "livre") {
      throw new ErroHttp(
        409,
        "CONVERSA_OCUPADA",
        "Há uma execução em andamento ou com resultado incerto nesta conversa.",
      );
    }

    const agora = new Date().toISOString();

    try {
      await this.cliente.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tabela,
                Key: this.chave(
                  usuario,
                  `CONVERSA#${conversa.conversa_id}`,
                ),
                UpdateExpression:
                  "SET #estado = :processando, requisicao_id = :requisicao, atualizada_em = :agora",
                ConditionExpression:
                  "#estado = :livre AND versao = :versao",
                ExpressionAttributeNames: {
                  "#estado": "estado",
                },
                ExpressionAttributeValues: {
                  ":processando": "processando",
                  ":livre": "livre",
                  ":requisicao": requisicao,
                  ":agora": agora,
                  ":versao": conversa.versao,
                },
              },
            },
            {
              Put: {
                TableName: this.tabela,
                Item: {
                  ...this.chave(
                    usuario,
                    `REQUISICAO#${conversa.conversa_id}#${requisicao}`,
                  ),
                  estado: "processando",
                  mensagem,
                  mensagem_hash: hash(mensagem),
                  sessao_runtime: sessaoRuntime,
                  criada_em: agora,
                },
                ConditionExpression:
                  "attribute_not_exists(registro_id)",
              },
            },
          ],
        }),
      );
    } catch (erro) {
      const atual = await this.requisicao(
        usuario,
        conversa.conversa_id,
        requisicao,
      );

      if (atual) {
        return this.verificarRepeticao(atual, mensagem);
      }

      if (erro.name === "TransactionCanceledException") {
        throw new ErroHttp(
          409,
          "CONVERSA_OCUPADA",
          "Outra requisição iniciou esta conversa. Atualize o histórico.",
        );
      }

      throw erro;
    }

    return { repetida: false };
  }

  async registrarMensagem(usuario, conversa, requisicao, sequencia, mensagem) {
    const texto = JSON.stringify(mensagem);

    if (Buffer.byteLength(texto, "utf8") > 300_000) {
      throw new Error("Mensagem de auditoria muito extensa.");
    }

    await this.cliente.send(
      new PutCommand({
        TableName: this.tabela,
        Item: {
          ...this.chave(
            usuario,
            `PROGRESSO#${conversa}#${requisicao}#${numero(sequencia)}`,
          ),
          mensagem_json: texto,
          criada_em: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(registro_id)",
      }),
    );
  }

  async concluir(usuario, conversa, requisicao, novasMensagens, resposta) {
    const mensagensJson = JSON.stringify(novasMensagens);

    if (
      Buffer.byteLength(mensagensJson, "utf8") > 300_000 ||
      typeof resposta !== "string" ||
      Buffer.byteLength(resposta, "utf8") > 64_000
    ) {
      throw new Error("Turno muito extenso para persistência.");
    }

    const versao = conversa.versao + 1;
    const agora = new Date().toISOString();

    try {
      await this.cliente.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tabela,
                Item: {
                  ...this.chave(
                    usuario,
                    `TURNO#${conversa.conversa_id}#${numero(versao)}`,
                  ),
                  versao,
                  requisicao_id: requisicao,
                  mensagens_json: mensagensJson,
                  criada_em: agora,
                },
                ConditionExpression:
                  "attribute_not_exists(registro_id)",
              },
            },
            {
              Update: {
                TableName: this.tabela,
                Key: this.chave(
                  usuario,
                  `CONVERSA#${conversa.conversa_id}`,
                ),
                UpdateExpression:
                  "SET #estado = :livre, versao = :nova, atualizada_em = :agora REMOVE requisicao_id",
                ConditionExpression:
                  "#estado = :processando AND requisicao_id = :requisicao AND versao = :anterior",
                ExpressionAttributeNames: {
                  "#estado": "estado",
                },
                ExpressionAttributeValues: {
                  ":livre": "livre",
                  ":processando": "processando",
                  ":requisicao": requisicao,
                  ":anterior": conversa.versao,
                  ":nova": versao,
                  ":agora": agora,
                },
              },
            },
            {
              Update: {
                TableName: this.tabela,
                Key: this.chave(
                  usuario,
                  `REQUISICAO#${conversa.conversa_id}#${requisicao}`,
                ),
                UpdateExpression:
                  "SET #estado = :concluida, resposta = :resposta, versao = :versao, concluida_em = :agora",
                ConditionExpression: "#estado = :processando",
                ExpressionAttributeNames: {
                  "#estado": "estado",
                },
                ExpressionAttributeValues: {
                  ":concluida": "concluida",
                  ":processando": "processando",
                  ":resposta": resposta,
                  ":versao": versao,
                  ":agora": agora,
                },
              },
            },
          ],
        }),
      );
    } catch (erro) {
      const atual = await this.requisicao(
        usuario,
        conversa.conversa_id,
        requisicao,
      );

      // A transação pode ter concluído antes de uma falha de rede.
      if (
        atual?.estado !== "concluida" ||
        atual.versao !== versao ||
        atual.resposta !== resposta
      ) {
        throw erro;
      }
    }

    return versao;
  }

  async marcarIncerta(usuario, conversa, requisicao) {
    await this.cliente.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tabela,
              Key: this.chave(usuario, `CONVERSA#${conversa}`),
              UpdateExpression:
                "SET #estado = :incerta, atualizada_em = :agora",
              ConditionExpression:
                "#estado = :processando AND requisicao_id = :requisicao",
              ExpressionAttributeNames: {
                "#estado": "estado",
              },
              ExpressionAttributeValues: {
                ":incerta": "incerta",
                ":processando": "processando",
                ":requisicao": requisicao,
                ":agora": new Date().toISOString(),
              },
            },
          },
          {
            Update: {
              TableName: this.tabela,
              Key: this.chave(
                usuario,
                `REQUISICAO#${conversa}#${requisicao}`,
              ),
              UpdateExpression: "SET #estado = :incerta",
              ConditionExpression: "#estado = :processando",
              ExpressionAttributeNames: {
                "#estado": "estado",
              },
              ExpressionAttributeValues: {
                ":incerta": "incerta",
                ":processando": "processando",
              },
            },
          },
        ],
      }),
    );
  }
}
