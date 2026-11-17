import { identidade } from "./autenticacao.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ErroHttp, tamanho } from "./repositorio.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validarUuid(valor) {
  if (typeof valor !== "string" || !UUID.test(valor)) {
    throw new ErroHttp(
      400,
      "IDENTIFICADOR_INVALIDO",
      "Identificador de conversa ou requisição inválido.",
    );
  }

  return valor.toLowerCase();
}

function lerCorpo(evento) {
  const bruto = evento.isBase64Encoded
    ? Buffer.from(evento.body ?? "", "base64").toString("utf8")
    : evento.body ?? "";

  if (Buffer.byteLength(bruto, "utf8") > 20_000) {
    throw new ErroHttp(413, "MENSAGEM_EXTENSA", "Mensagem muito extensa.");
  }

  let corpo;

  try {
    corpo = JSON.parse(bruto || "{}");
  } catch {
    throw new ErroHttp(400, "JSON_INVALIDO", "Envie um objeto JSON válido.");
  }

  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
    throw new ErroHttp(400, "PAYLOAD_INVALIDO", "Envie um objeto JSON.");
  }

  return corpo;
}

function somenteCampos(corpo, permitidos) {
  if (Object.keys(corpo).some((campo) => !permitidos.includes(campo))) {
    throw new ErroHttp(
      400,
      "CAMPOS_INVALIDOS",
      "A requisição contém campos não permitidos.",
    );
  }
}

function validarResultado(resultado, historico, mensagem) {
  const completo = resultado.historico;

  if (
    typeof resultado.resposta !== "string" ||
    !Array.isArray(completo) ||
    completo.length <= historico.length ||
    !isDeepStrictEqual(
      completo.slice(0, historico.length),
      historico,
    )
  ) {
    throw new Error("Histórico final incompatível com a conversa.");
  }

  const novas = completo.slice(historico.length);

  if (
    novas.some(
      (item) =>
        !item ||
        !["user", "assistant"].includes(item.role) ||
        !Array.isArray(item.content),
    ) ||
    novas[0].role !== "user" ||
    novas[0].content.length !== 1 ||
    novas[0].content[0]?.text !== mensagem ||
    novas.at(-1).role !== "assistant"
  ) {
    throw new Error("Turno final inválido.");
  }

  if (tamanho(completo) > 1_000_000) {
    throw new Error("Histórico final muito extenso.");
  }

  return novas;
}

export function criarAplicacao({
  repositorio,
  invocar,
  clientId,
  origem,
}) {
  return async function atender(evento, abrirResposta) {
    let escrever;
    let usuario;
    let conversa;
    let requisicao;
    let emExecucao = false;
    let batimento;

    const cabecalhos = {
      "Access-Control-Allow-Origin": origem,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };

    const json = async (statusCode, valor) => {
      escrever = abrirResposta({
        statusCode,
        headers: {
          ...cabecalhos,
          "Content-Type": "application/json; charset=utf-8",
        },
      });

      await escrever(JSON.stringify(valor));
    };

    const emitir = async (valor) => {
      await escrever(`data: ${JSON.stringify(valor)}\n\n`);
    };

    try {
      usuario = identidade(evento, clientId);

      const metodo = evento.httpMethod;
      const recurso = evento.resource;

      if (recurso === "/conversas" && metodo === "POST") {
        somenteCampos(lerCorpo(evento), []);
        await json(201, await repositorio.criar(usuario));
        return;
      }

      if (recurso === "/conversas" && metodo === "GET") {
        await json(200, {
          conversas: await repositorio.listar(usuario),
        });
        return;
      }

      if (recurso === "/conversas/{conversa_id}" && metodo === "GET") {
        const id = validarUuid(evento.pathParameters?.conversa_id);
        let metadados = await repositorio.obter(usuario, id);
        let requisicaoConsultada = null;
        const identificador = evento.queryStringParameters?.requisicao_id;

        if (identificador != null) {
          const pedidoId = validarUuid(identificador);
          const pedido = await repositorio.requisicao(usuario, id, pedidoId);

          requisicaoConsultada = {
            requisicao_id: pedidoId,
            estado: pedido?.estado ?? "nao_recebida",
            versao: pedido?.versao ?? null,
          };

          if (
            pedido?.estado === "concluida" &&
            pedido.versao > metadados.versao
          ) {
            metadados = await repositorio.obter(usuario, id);
          }
        }

        const historico = await repositorio.historico(usuario, metadados);

        await json(200, {
          ...metadados,
          historico,
          requisicao: requisicaoConsultada,
        });
        return;
      }

      if (recurso !== "/chat" || metodo !== "POST") {
        throw new ErroHttp(404, "ROTA_INVALIDA", "Rota não encontrada.");
      }

      const corpo = lerCorpo(evento);

      somenteCampos(corpo, [
        "conversa_id",
        "requisicao_id",
        "mensagem",
      ]);

      conversa = validarUuid(corpo.conversa_id);
      requisicao = validarUuid(corpo.requisicao_id);

      if (
        typeof corpo.mensagem !== "string" ||
        !corpo.mensagem.trim() ||
        corpo.mensagem.length > 4000
      ) {
        throw new ErroHttp(
          400,
          "MENSAGEM_INVALIDA",
          "Envie uma mensagem de até 4.000 caracteres.",
        );
      }

      const mensagem = corpo.mensagem.trim();
      const metadados = await repositorio.obter(usuario, conversa);
      const historico = await repositorio.historico(usuario, metadados);
      const sessaoRuntime = randomUUID();

      const inicio = await repositorio.iniciar(
        usuario,
        metadados,
        requisicao,
        mensagem,
        sessaoRuntime,
      );

      emExecucao = !inicio.repetida;

      escrever = abrirResposta({
        statusCode: 200,
        headers: {
          ...cabecalhos,
          "Content-Type": "text/event-stream; charset=utf-8",
        },
      });

      await emitir({
        tipo: "inicio",
        conversa_id: conversa,
        requisicao_id: requisicao,
        repetida: inicio.repetida,
      });

      if (inicio.repetida) {
        const salvo = inicio.requisicao;
        const historicoSalvo = await repositorio.historico(usuario, {
          ...metadados,
          versao: salvo.versao,
        });

        await emitir({
          tipo: "fim",
          conversa_id: conversa,
          requisicao_id: requisicao,
          versao: salvo.versao,
          resposta: salvo.resposta,
          historico: historicoSalvo,
          repetida: true,
        });

        return;
      }

      batimento = setInterval(() => {
        void escrever(": aguardando\n\n");
      }, 10_000);
      batimento.unref();

      let final;
      let ultimaSequencia = 0;

      const fluxo = invocar(
        {
          mensagem,
          contexto: { usuario_id: usuario },
          historico,
          stream: true,
        },
        sessaoRuntime,
      );

      for await (const parte of fluxo) {
        if (parte.tipo === "delta") {
          if (typeof parte.texto !== "string") {
            throw new Error("Delta inválido.");
          }

          await emitir({ tipo: "delta", texto: parte.texto });
          continue;
        }

        if (parte.tipo === "mensagem") {
          if (
            !Number.isInteger(parte.sequencia) ||
            parte.sequencia !== ultimaSequencia + 1 ||
            !parte.mensagem ||
            typeof parte.mensagem !== "object" ||
            Array.isArray(parte.mensagem)
          ) {
            throw new Error("Mensagem de progresso inválida.");
          }

          await repositorio.registrarMensagem(
            usuario,
            conversa,
            requisicao,
            parte.sequencia,
            parte.mensagem,
          );

          ultimaSequencia = parte.sequencia;

          await emitir({
            tipo: "mensagem",
            sequencia: parte.sequencia,
            mensagem: parte.mensagem,
          });

          continue;
        }

        if (parte.tipo === "erro") {
          throw new Error("O runtime informou falha na execução.");
        }

        if (parte.tipo === "fim") {
          const novas = validarResultado(parte, historico, mensagem);

          const versao = await repositorio.concluir(
            usuario,
            metadados,
            requisicao,
            novas,
            parte.resposta,
          );

          emExecucao = false;

          final = {
            tipo: "fim",
            conversa_id: conversa,
            requisicao_id: requisicao,
            versao,
            resposta: parte.resposta,
            historico: parte.historico,
            repetida: false,
          };

          break;
        }

        throw new Error("Tipo de evento desconhecido.");
      }

      if (!final) {
        throw new Error("Streaming encerrado sem resultado final.");
      }

      // O histórico já foi confirmado no DynamoDB.
      await emitir(final);
    } catch (erro) {
      if (emExecucao) {
        try {
          await repositorio.marcarIncerta(usuario, conversa, requisicao);
        } catch {
          console.error("CHAT_FALHA_AO_REGISTRAR_ESTADO_INCERTO");
        }
      }

      if (!(erro instanceof ErroHttp)) {
        console.error(JSON.stringify({
          evento: "CHAT_FALHA",
          request_id: evento.requestContext?.requestId,
          classe: erro.name,
        }));
      }

      const falha = {
        tipo: "erro",
        erro: erro instanceof ErroHttp ? erro.codigo : "EXECUCAO_INCERTA",
        mensagem: erro instanceof ErroHttp
          ? erro.message
          : "Não foi possível confirmar a conclusão. Consulte a conversa antes de repetir uma compra.",
        conversa_id: conversa,
        requisicao_id: requisicao,
      };

      if (escrever) {
        await emitir(falha);
      } else {
        await json(erro instanceof ErroHttp ? erro.status : 500, falha);
      }
    } finally {
      clearInterval(batimento);
    }
  };
}
