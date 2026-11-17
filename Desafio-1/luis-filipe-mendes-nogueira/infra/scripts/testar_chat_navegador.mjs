async function contexto() {
  const resposta = await fetch("/config.json", { cache: "no-store" });
  if (!resposta.ok) throw new Error("Configuração local indisponível.");

  const config = await resposta.json();

  for (const campo of ["apiUrl", "chatApiUrl"]) {
    const url = new URL(config[campo]);

    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(url.hostname)
    ) {
      throw new Error(`Configuração inválida: ${campo}.`);
    }
  }

  const prefixo =
    `CognitoIdentityServiceProvider.${config.cognito.userPoolClientId}`;
  const usuario = localStorage.getItem(`${prefixo}.LastAuthUser`);
  const token = usuario
    ? localStorage.getItem(`${prefixo}.${usuario}.accessToken`)
    : null;

  if (!token) {
    throw new Error("Entre na aplicação antes de executar os testes.");
  }

  return { config, token };
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function verificar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

function centavos(valor) {
  verificar(
    typeof valor === "number" && Number.isFinite(valor),
    "Valor monetário inválido.",
  );
  return Math.round(valor * 100);
}

function resultados(historico, inicio = 0) {
  const ferramentas = new Map();
  const encontrados = [];

  for (let indice = 0; indice < historico.length; indice++) {
    for (const bloco of historico[indice].content ?? []) {
      if (bloco.toolUse) {
        ferramentas.set(bloco.toolUse.toolUseId, bloco.toolUse);
      }

      const retorno = bloco.toolResult;
      if (!retorno || indice < inicio) continue;

      const chamada = ferramentas.get(retorno.toolUseId);
      if (!chamada) continue;

      for (const conteudo of retorno.content ?? []) {
        let valor = conteudo.json;

        if (typeof conteudo.text === "string") {
          try {
            valor = JSON.parse(conteudo.text);
          } catch {
            continue;
          }
        }

        if (valor && typeof valor === "object") {
          encontrados.push({
            nome: chamada.name,
            argumentos: chamada.input,
            valor,
          });
        }
      }
    }
  }

  return encontrados;
}

export async function consultarResultado(conversaId, requisicaoId) {
  const { config, token } = await contexto();
  const parametros = requisicaoId
    ? `?requisicao_id=${encodeURIComponent(requisicaoId)}`
    : "";

  const resposta = await fetch(
    `${config.chatApiUrl}/conversas/${encodeURIComponent(conversaId)}${parametros}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(20_000),
    },
  );

  if (!resposta.ok) {
    throw new Error(`Consulta retornou HTTP ${resposta.status}.`);
  }

  return resposta.json();
}

export async function validarIsolamento(conversaId, donoUsuarioId) {
  const { config, token } = await contexto();
  const headers = { Authorization: `Bearer ${token}` };

  const perfilResposta = await fetch(`${config.apiUrl}/me`, {
    headers,
    cache: "no-store",
  });
  verificar(perfilResposta.ok, "Não foi possível carregar o segundo perfil.");

  const perfil = await perfilResposta.json();

  verificar(
    perfil.id !== donoUsuarioId,
    "É necessário entrar com outro usuário para este teste.",
  );

  const resposta = await fetch(
    `${config.chatApiUrl}/conversas/${encodeURIComponent(conversaId)}`,
    { headers, cache: "no-store" },
  );
  await resposta.text();

  verificar(
    resposta.status === 404,
    `Conversa de outro usuário retornou HTTP ${resposta.status}.`,
  );

  console.log("OK — conversa de outro usuário não é acessível.");
}

export function baixarRelatorio(relatorio) {
  const blob = new Blob(
    [JSON.stringify(relatorio, null, 2)],
    { type: "application/json" },
  );
  const endereco = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = endereco;
  link.download = "luisfilipe-chat-validacao.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(endereco), 5000);
}

export async function validarChat({
  compras = false,
  expiracao = false,
} = {}) {
  const relatorio = {
    inicio: new Date().toISOString(),
    ok: false,
    testes: [],
    requisicoes: [],
    compras: [],
  };

  let testeAtual = "Preparação";
  let fila = Promise.resolve();
  let ultimaChamada = 0;
  const historicos = new Map();

  try {
    verificar(!expiracao || compras, "Expiração requer compras: true.");

    const { config, token } = await contexto();

    async function vez() {
      const atual = fila.then(async () => {
        const restante = 700 - (performance.now() - ultimaChamada);
        if (restante > 0) await esperar(restante);
        ultimaChamada = performance.now();
      });
      fila = atual.catch(() => {});
      await atual;
    }

    async function abrir(
      caminho,
      metodo = "GET",
      corpo,
      credencial = token,
      base = config.chatApiUrl,
    ) {
      await vez();

      const headers = new Headers();
      if (credencial) headers.set("Authorization", `Bearer ${credencial}`);
      if (corpo !== undefined) headers.set("Content-Type", "application/json");

      return fetch(`${base}${caminho}`, {
        method: metodo,
        headers,
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(140_000),
      });
    }

    async function json(
      caminho,
      metodo = "GET",
      corpo,
      status = 200,
      credencial = token,
      base = config.chatApiUrl,
    ) {
      const resposta = await abrir(
        caminho, metodo, corpo, credencial, base,
      );
      const texto = await resposta.text();

      verificar(
        resposta.status === status,
        `${metodo} ${caminho}: HTTP ${resposta.status}; esperado ${status}.`,
      );

      return texto ? JSON.parse(texto) : {};
    }

    async function perfil() {
      return json("/me", "GET", undefined, 200, token, config.apiUrl);
    }

    async function nova() {
      const conversa = await json("/conversas", "POST", {}, 201);
      verificar(conversa.conversa_id, "Conversa criada sem identificador.");
      historicos.set(conversa.conversa_id, []);
      return conversa.conversa_id;
    }

    async function chat(pedido, aceitarConflito = false) {
      relatorio.requisicoes.push({
        conversa_id: pedido.conversa_id,
        requisicao_id: pedido.requisicao_id,
      });

      const inicio = performance.now();
      const resposta = await abrir("/chat", "POST", pedido);

      if (aceitarConflito && resposta.status === 409) {
        return { status: 409, erro: await resposta.json() };
      }

      verificar(
        resposta.status === 200,
        `Chat retornou HTTP ${resposta.status}.`,
      );
      verificar(
        resposta.headers.get("content-type")?.startsWith("text/event-stream"),
        "O chat não retornou SSE.",
      );
      verificar(resposta.body, "Resposta sem streaming.");

      const leitor = resposta.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let dados = [];
      let final;
      let primeiroDelta;
      let bytes = 0;

      try {
        externo: while (true) {
          const leitura = await leitor.read();
          if (leitura.done) break;

          bytes += leitura.value.byteLength;
          verificar(bytes < 8_000_000, "Resposta muito extensa.");
          buffer += decoder.decode(leitura.value, { stream: true });

          let posicao;
          while ((posicao = buffer.indexOf("\n")) >= 0) {
            const linha = buffer.slice(0, posicao).replace(/\r$/, "");
            buffer = buffer.slice(posicao + 1);

            if (linha === "") {
              if (!dados.length) continue;

              const texto = dados.join("\n");
              dados = [];
              if (texto === "[DONE]") continue;

              const evento = JSON.parse(texto);

              if (evento.tipo === "erro") {
                throw new Error(
                  `Chat: ${evento.erro}. Consulte a requisição antes de repetir.`,
                );
              }

              if (evento.tipo === "delta" && primeiroDelta === undefined) {
                primeiroDelta = Math.round(performance.now() - inicio);
              }

              if (evento.tipo === "fim") {
                final = evento;
                break externo;
              }
            } else if (linha.startsWith("data:")) {
              dados.push(linha.slice(5).replace(/^ /, ""));
            }
          }
        }
      } finally {
        try { await leitor.cancel(); } catch {}
        leitor.releaseLock();
      }

      verificar(final, "Streaming terminou sem evento fim.");
      verificar(
        final.conversa_id === pedido.conversa_id &&
        final.requisicao_id === pedido.requisicao_id,
        "Resposta vinculada à requisição errada.",
      );
      verificar(Array.isArray(final.historico), "Histórico final ausente.");

      const anterior = historicos.get(pedido.conversa_id) ?? [];

      if (!final.repetida) {
        verificar(
          JSON.stringify(final.historico.slice(0, anterior.length)) ===
          JSON.stringify(anterior),
          "O histórico anterior foi alterado.",
        );
      }

      historicos.set(pedido.conversa_id, final.historico);

      relatorio.requisicoes.at(-1).primeiro_delta_ms = primeiroDelta;
      relatorio.requisicoes.at(-1).duracao_ms =
        Math.round(performance.now() - inicio);

      return {
        status: 200,
        final,
        novos: resultados(final.historico, anterior.length),
        pedido,
      };
    }

    async function dizer(conversa, mensagem) {
      return chat({
        conversa_id: conversa,
        requisicao_id: crypto.randomUUID(),
        mensagem,
      });
    }

    async function testar(nome, acao) {
      testeAtual = nome;
      const resultado = await acao();
      relatorio.testes.push({ teste: nome, ok: true });
      console.log(`OK — ${nome}`);
      return resultado;
    }

    const usuario = await perfil();
    relatorio.usuario_id = usuario.id;
    relatorio.saldo_inicial_centavos = centavos(usuario.limiteGasto);

    await testar("Requisição anônima bloqueada", async () => {
      const resposta = await abrir("/conversas", "GET", undefined, null);
      await resposta.text();
      verificar(
        [401, 403].includes(resposta.status),
        "A API aceitou uma chamada anônima.",
      );
    });

    await testar("Token inválido bloqueado", async () => {
      const resposta = await abrir(
        "/conversas", "GET", undefined, "token-invalido",
      );
      await resposta.text();
      verificar(
        [401, 403].includes(resposta.status),
        "A API aceitou um token inválido.",
      );
    });

    const conversa = await testar("Criar e listar conversa", async () => {
      const id = await nova();
      const lista = await json("/conversas");
      verificar(
        lista.conversas.some((item) => item.conversa_id === id),
        "Conversa ausente na listagem.",
      );

      const detalhe = await json(`/conversas/${id}`);
      verificar(
        detalhe.estado === "livre" && detalhe.historico.length === 0,
        "Conversa nova contém histórico ou está bloqueada.",
      );

      return id;
    });

    relatorio.conversa_para_teste_de_isolamento = conversa;

    await testar("Identidade e histórico no corpo são rejeitados", async () => {
      for (const extra of [
        { usuario_id: "outro-usuario" },
        { contexto: { usuario_id: "outro-usuario" } },
        { historico: [] },
        { messages: [] },
      ]) {
        const falha = await json("/chat", "POST", {
          conversa_id: conversa,
          requisicao_id: crypto.randomUUID(),
          mensagem: "Não chame ferramentas.",
          ...extra,
        }, 400);

        verificar(falha.erro === "CAMPOS_INVALIDOS", "Recusa inesperada.");
      }

      const detalhe = await json(`/conversas/${conversa}`);
      verificar(detalhe.versao === 0, "Uma entrada inválida iniciou o agente.");
    });

    await testar("Conversa inexistente retorna 404", async () => {
      await json(`/conversas/${crypto.randomUUID()}`, "GET", undefined, 404);
    });

    const referencia = `REF-${crypto.randomUUID()}`;

    await testar("Streaming autenticado", async () => {
      const resposta = await dizer(
        conversa,
        `Código desta conversa: ${referencia}. ` +
        "Responda apenas OK. Não use ferramentas.",
      );
      verificar(resposta.final.resposta.trim() === "OK", "Resposta inesperada.");
      verificar(
        resultados(resposta.final.historico).length === 0,
        "O agente usou ferramentas sem necessidade.",
      );
    });

    const continuacao = await testar("Histórico completo entre turnos", async () => {
      const resposta = await dizer(
        conversa,
        "Qual é o código informado na primeira mensagem? " +
        "Responda apenas com o código. Não use ferramentas.",
      );

      verificar(
        resposta.final.resposta.includes(referencia),
        "O agente não recuperou a referência.",
      );

      const salvo = await json(`/conversas/${conversa}`);

      verificar(
        JSON.stringify(salvo.historico) ===
        JSON.stringify(resposta.final.historico),
        "O histórico persistido difere do retornado.",
      );

      return resposta;
    });

    await testar("Reenvio da mesma requisição não cria outro turno", async () => {
      const repetida = await chat(continuacao.pedido);

      verificar(repetida.final.repetida === true, "Resposta não foi reutilizada.");
      verificar(
        repetida.final.versao === continuacao.final.versao,
        "O reenvio criou outro turno.",
      );
    });

    await testar("Mesmo ID com mensagem diferente é rejeitado", async () => {
      const falha = await json("/chat", "POST", {
        ...continuacao.pedido,
        mensagem: "Outra mensagem.",
      }, 409);

      verificar(
        falha.erro === "REQUISICAO_DIVERGENTE",
        "Código de recusa inesperado.",
      );
    });

    await testar("Requisições duplicadas concorrentes geram um turno", async () => {
      const antes = await json(`/conversas/${conversa}`);
      const pedido = {
        conversa_id: conversa,
        requisicao_id: crypto.randomUUID(),
        mensagem: "Responda apenas OK. Não use ferramentas.",
      };

      const respostas = await Promise.all([
        chat(pedido, true),
        chat(pedido, true),
      ]);

      verificar(
        respostas.some((item) => item.status === 200),
        "Nenhuma requisição concorrente concluiu.",
      );

      const depois = await json(`/conversas/${conversa}`);

      verificar(
        depois.versao === antes.versao + 1,
        "A duplicação gerou mais de um turno.",
      );
    });

    await testar("Consulta de recuperação confirma o resultado", async () => {
      const detalhe = await json(
        `/conversas/${conversa}?requisicao_id=${continuacao.pedido.requisicao_id}`,
      );

      verificar(
        detalhe.requisicao?.estado === "concluida",
        "A consulta não identificou a requisição concluída.",
      );
    });

    const isolada = await nova();

    await testar("Uma conversa não herda o histórico de outra", async () => {
      const resposta = await dizer(
        isolada,
        "Se não houver código de referência nesta conversa, " +
        "responda apenas SEM_CODIGO. Não use ferramentas.",
      );

      verificar(
        resposta.final.resposta.trim() === "SEM_CODIGO",
        "A conversa nova apresentou uma referência inesperada.",
      );
    });

    async function catalogo(id) {
      const resposta = await dizer(
        id,
        "Use listar_catalogo sem filtro para mostrar os eventos, preços e vagas. " +
        "Não registre intenções nem realize compras.",
      );

      verificar(
        resposta.novos.every((item) => item.nome === "listar_catalogo"),
        "A consulta executou uma ferramenta de compra.",
      );

      const listas = resposta.novos.filter(
        (item) => item.nome === "listar_catalogo" &&
          Array.isArray(item.valor.produtos),
      );

      verificar(listas.length > 0, "Catálogo ausente no resultado da ferramenta.");
      return listas.at(-1).valor.produtos;
    }

    const produtos = await testar(
      "Catálogo real por ferramenta",
      () => catalogo(isolada),
    );

    await testar("Consultas não alteram o saldo", async () => {
      const atual = await perfil();
      verificar(
        centavos(atual.limiteGasto) === relatorio.saldo_inicial_centavos,
        "O saldo mudou durante testes sem compra.",
      );
    });

    if (compras) {
      const barato = produtos.find((item) => item.id === "evt_004");
      const caro = produtos.find((item) => item.id === "evt_003");

      verificar(
        barato && centavos(barato.preco) === 2500 && barato.estoque >= 2,
        "O teste exige duas vagas de R$ 25 no evt_004.",
      );

      verificar(
        caro && caro.estoque > 0,
        "O teste de limite exige uma vaga disponível no evt_003.",
      );

      verificar(
        centavos((await perfil()).limiteGasto) >= 5000,
        "Saldo insuficiente para as duas compras simuladas de teste.",
      );

      async function reservar(evento) {
        const id = await nova();
        const resposta = await dizer(
          id,
          `Quero reservar um ingresso do evento ${evento.id}. ` +
          "Use registrar_intencao, apresente o total e aguarde minha confirmação. " +
          "Não execute realizar_compra agora.",
        );

        verificar(
          !resposta.novos.some((item) => item.nome === "realizar_compra"),
          "O agente tentou pagar antes da confirmação.",
        );

        const reservas = resposta.novos.filter(
          (item) => item.nome === "registrar_intencao" &&
            item.valor.status === "pendente",
        );

        verificar(reservas.length === 1, "Era esperada uma reserva.");
        const intencao = reservas[0].valor;

        verificar(
          intencao.eventoId === evento.id &&
          intencao.quantidade === 1 &&
          centavos(intencao.valorTotal) === centavos(evento.preco) &&
          intencao.usuarioId === usuario.id,
          "Reserva com identidade, evento, quantidade ou valor inesperado.",
        );

        return { conversa: id, intencao };
      }

      function confirmacao(reserva, metodo) {
        return (
          `Confirmo a compra apresentada de um ingresso, evento ` +
          `${reserva.intencao.eventoId}, total R$ ` +
          `${reserva.intencao.valorTotal}, intenção ` +
          `${reserva.intencao.intencaoId}. ` +
          `Pague com ${metodo === "pix" ? "Pix" : "cartão"}.`
        );
      }

      for (const metodo of ["cartao", "pix"]) {
        await testar(`Compra ${metodo} e reenvio sem novo débito`, async () => {
          const reserva = await reservar(barato);
          const saldoAntes = centavos((await perfil()).limiteGasto);

          const resposta = await dizer(
            reserva.conversa,
            confirmacao(reserva, metodo),
          );

          const pagamentos = resposta.novos.filter(
            (item) => item.nome === "realizar_compra",
          );

          verificar(
            pagamentos.length === 1 &&
            pagamentos[0].valor.status === "aprovado" &&
            pagamentos[0].valor.intencao_id === reserva.intencao.intencaoId &&
            pagamentos[0].valor.metodo_pagamento === metodo &&
            centavos(pagamentos[0].valor.valor) === 2500,
            "A ferramenta não confirmou o pagamento esperado.",
          );

          const depois = centavos((await perfil()).limiteGasto);
          verificar(depois === saldoAntes - 2500, "Débito diferente de R$ 25.");

          const repetida = await chat(resposta.pedido);

          verificar(
            repetida.final.repetida === true &&
            repetida.final.versao === resposta.final.versao,
            "O pagamento não foi recuperado como resposta salva.",
          );

          verificar(
            centavos((await perfil()).limiteGasto) === depois,
            "O reenvio consumiu saldo novamente.",
          );

          relatorio.compras.push({
            metodo,
            intencao_id: reserva.intencao.intencaoId,
            transacao_id: pagamentos[0].valor.transacao_id,
            valor_centavos: 2500,
          });
        });
      }

      let reservaLimite;

      await testar("Limite insuficiente não debita saldo", async () => {
        const saldoAntes = centavos((await perfil()).limiteGasto);

        verificar(
          centavos(caro.preco) > saldoAntes,
          "O evento escolhido não excede o saldo atual.",
        );

        reservaLimite = await reservar(caro);

        const resposta = await dizer(
          reservaLimite.conversa,
          confirmacao(reservaLimite, "cartao"),
        );

        const pagamentos = resposta.novos.filter(
          (item) => item.nome === "realizar_compra",
        );

        verificar(
          pagamentos.length === 1 &&
          pagamentos[0].valor.erro === "LIMITE_EXCEDIDO",
          "Era esperada a recusa LIMITE_EXCEDIDO.",
        );

        verificar(
          centavos((await perfil()).limiteGasto) === saldoAntes,
          "A recusa alterou o saldo.",
        );
      });

      if (expiracao) {
        await testar("Expiração devolve a reserva uma única vez", async () => {
          const antes = await catalogo(reservaLimite.conversa);
          const vagasAntes = antes.find((item) => item.id === caro.id)?.estoque;
          verificar(Number.isInteger(vagasAntes), "Estoque não encontrado.");

          const prazo = Date.parse(reservaLimite.intencao.expiraEm);
          verificar(Number.isFinite(prazo), "Prazo da reserva inválido.");

          while (Date.now() <= prazo + 2000) {
            const restante = Math.ceil((prazo + 2000 - Date.now()) / 1000);
            console.log(`Aguardando expiração: aproximadamente ${restante}s.`);
            await esperar(Math.min(30_000, Math.max(1000, restante * 1000)));
          }

          const saldoAntes = centavos((await perfil()).limiteGasto);
          const depois = await catalogo(reservaLimite.conversa);
          const vagasDepois = depois.find((item) => item.id === caro.id)?.estoque;

          verificar(
            vagasDepois === vagasAntes + 1,
            "A expiração não devolveu exatamente uma vaga.",
          );

          const novamente = await catalogo(reservaLimite.conversa);

          verificar(
            novamente.find((item) => item.id === caro.id)?.estoque === vagasDepois,
            "A reserva foi devolvida novamente.",
          );

          verificar(
            centavos((await perfil()).limiteGasto) === saldoAntes,
            "A expiração alterou o saldo.",
          );
        });
      }

      verificar(
        centavos((await perfil()).limiteGasto) ===
          relatorio.saldo_inicial_centavos - 5000,
        "Saldo final diferente dos dois débitos de R$ 25.",
      );
    }

    relatorio.saldo_final_centavos =
      centavos((await perfil()).limiteGasto);
    relatorio.ok = true;
  } catch (erro) {
    relatorio.testes.push({
      teste: testeAtual,
      ok: false,
      erro: erro.message,
    });

    console.error(
      `FALHOU — ${testeAtual}: ${erro.message}`,
    );
    console.error(
      "Não repita o lote de compras. Consulte o resultado da requisição.",
    );
  } finally {
    relatorio.fim = new Date().toISOString();
    console.table(relatorio.testes);
    console.log(
      relatorio.ok
        ? "TESTES SOLICITADOS CONCLUÍDOS."
        : "TESTE INTERROMPIDO. Guarde o relatório.",
    );
  }

  return relatorio;
}
