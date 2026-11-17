import { randomUUID } from "node:crypto"
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb"
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb"
import { ddb, tabela } from "./shared/ddb"
import { centavosParaReais, formatarValor } from "./shared/dinheiro"
import { criarHandler, ehGuid } from "./shared/handler"
import { recusar, type Recusa } from "./shared/respostas"
import { buscarUsuario, garantirUsuario } from "./shared/usuarios"

export const METODOS_PAGAMENTO = ["cartao", "pix"] as const
export type MetodoPagamento = (typeof METODOS_PAGAMENTO)[number]

export interface CompraAprovada {
    status: "aprovado"
    transacao_id: string
    intencao_id: string
    valor: number
    metodo_pagamento: MetodoPagamento
    limite_restante: number
    data: string
}

interface Intencao {
    intencao_id: string
    usuario_id: string
    produto_id: string
    quantidade: number
    valor_total_centavos: number
    moeda: string
    status: "pendente" | "paga"
    expira_em: string
}

const MSG_JA_PAGA = "Essa intenção de compra já foi paga. Registre uma nova intenção se quiser comprar de novo."
const MSG_EXPIRADA = "Essa intenção de compra expirou. Registre uma nova intenção para seguir com a compra."

function intencaoInvalida(intencaoId: string): Recusa {
    return recusar(
        "INTENCAO_INVALIDA",
        `Não existe nenhuma intenção de compra com o id "${intencaoId}" para este usuário. Registre a intenção com registrar_intencao antes de pagar.`
    )
}

function limiteExcedido(intencao: Intencao, disponivelCentavos: number): Recusa {
    return recusar(
        "LIMITE_EXCEDIDO",
        `A compra de ${formatarValor(intencao.moeda, intencao.valor_total_centavos)} ultrapassa o limite disponível do usuário, que é de ${formatarValor(intencao.moeda, disponivelCentavos)}.`
    )
}

function estoqueInsuficiente(nome: string, estoque: number, quantidade: number): Recusa {
    return recusar(
        "ESTOQUE_INSUFICIENTE",
        `O estoque de "${nome}" mudou desde o registro da intenção: restam ${estoque} unidades e a intenção pede ${quantidade}. Registre uma nova intenção com uma quantidade menor.`
    )
}

async function buscarIntencao(intencaoId: string): Promise<Intencao | undefined> {
    const { Item } = await ddb.send(
        new GetCommand({
            TableName: tabela("TABELA_INTENCOES"),
            Key: { intencao_id: intencaoId },
            ConsistentRead: true,
        })
    )
    return Item as Intencao | undefined
}

export const handler = criarHandler("realizar_compra", async ({ usuarioId, argumentos }) => {
    if (usuarioId == null) {
        return recusar(
            "INTENCAO_INVALIDA",
            "Não foi possível identificar o usuário da sessão. A compra não pode ser concluída."
        )
    }

    const { intencao_id, metodo_pagamento } = argumentos

    // Id inventado pelo modelo (ex.: "int_a1b2c3") é recusado antes de ir ao banco.
    if (!ehGuid(intencao_id)) {
        return intencaoInvalida(String(intencao_id ?? ""))
    }

    // Validado no handler (e não como enum no schema da tool) para METODO_INVALIDO
    // sempre voltar no formato padrão de recusa.
    if (!METODOS_PAGAMENTO.includes(metodo_pagamento as MetodoPagamento)) {
        return recusar(
            "METODO_INVALIDO",
            `"${String(metodo_pagamento ?? "")}" não é um método de pagamento aceito. Os métodos disponíveis são cartao e pix.`
        )
    }
    const metodo = metodo_pagamento as MetodoPagamento

    // --- Pré-checagens: dão a mensagem certa ao usuário. A garantia de verdade
    // contra corrida e duplicidade são as condições da transação mais abaixo.

    const intencao = await buscarIntencao(intencao_id)

    // Intenção de outro usuário é indistinguível de uma inexistente.
    if (intencao == null || intencao.usuario_id !== usuarioId) {
        return intencaoInvalida(intencao_id)
    }

    if (intencao.status !== "pendente") {
        return recusar("INTENCAO_JA_PAGA", MSG_JA_PAGA)
    }

    const agora = new Date()
    if (new Date(intencao.expira_em).getTime() <= agora.getTime()) {
        return recusar("INTENCAO_EXPIRADA", MSG_EXPIRADA)
    }

    await garantirUsuario(usuarioId)
    const usuario = await buscarUsuario(usuarioId)
    const disponivel = usuario?.limite_disponivel_centavos ?? 0

    // O valor vem da intenção gravada, nunca de um argumento do modelo.
    const valor = intencao.valor_total_centavos

    if (valor > disponivel) {
        return limiteExcedido(intencao, disponivel)
    }

    const { Item: produto } = await ddb.send(
        new GetCommand({
            TableName: tabela("TABELA_PRODUTOS"),
            Key: { produto_id: intencao.produto_id },
            ConsistentRead: true,
        })
    )

    if (produto == null) {
        return recusar(
            "INTENCAO_INVALIDA",
            "O produto dessa intenção não está mais disponível no catálogo. Registre uma nova intenção."
        )
    }

    if (produto.estoque < intencao.quantidade) {
        return estoqueInsuficiente(produto.nome, produto.estoque, intencao.quantidade)
    }

    // --- Escrita atômica: tudo ou nada. Se a mesma chamada chegar duas vezes (ou
    // duas compras correrem juntas), só uma passa nas condições; a outra é
    // cancelada inteira e nenhum limite ou estoque é descontado em dobro.
    const transacaoId = randomUUID()
    const agoraIso = agora.toISOString()

    try {
        await ddb.send(
            new TransactWriteCommand({
                TransactItems: [
                    {
                        // [0] intenção pendente → paga, se for do usuário e não tiver expirado
                        Update: {
                            TableName: tabela("TABELA_INTENCOES"),
                            Key: { intencao_id },
                            UpdateExpression: "SET #status = :paga, pago_em = :agora, transacao_id = :transacao",
                            ConditionExpression:
                                "usuario_id = :usuario AND #status = :pendente AND expira_em > :agora",
                            ExpressionAttributeNames: { "#status": "status" },
                            ExpressionAttributeValues: {
                                ":paga": "paga",
                                ":pendente": "pendente",
                                ":usuario": usuarioId,
                                ":agora": agoraIso,
                                ":transacao": transacaoId,
                            },
                        },
                    },
                    {
                        // [1] desconta o limite só se houver saldo
                        Update: {
                            TableName: tabela("TABELA_USUARIOS"),
                            Key: { usuario_id: usuarioId },
                            UpdateExpression: "SET limite_disponivel_centavos = limite_disponivel_centavos - :valor",
                            ConditionExpression: "limite_disponivel_centavos >= :valor",
                            ExpressionAttributeValues: { ":valor": valor },
                        },
                    },
                    {
                        // [2] baixa o estoque só se ainda houver unidades
                        Update: {
                            TableName: tabela("TABELA_PRODUTOS"),
                            Key: { produto_id: intencao.produto_id },
                            UpdateExpression: "SET estoque = estoque - :quantidade",
                            ConditionExpression: "estoque >= :quantidade",
                            ExpressionAttributeValues: { ":quantidade": intencao.quantidade },
                        },
                    },
                    {
                        // [3] no máximo uma transação por intenção (PK = intencao_id)
                        Put: {
                            TableName: tabela("TABELA_TRANSACOES"),
                            Item: {
                                intencao_id,
                                transacao_id: transacaoId,
                                usuario_id: usuarioId,
                                valor_centavos: valor,
                                moeda: intencao.moeda,
                                metodo_pagamento: metodo,
                                status: "aprovado",
                                criado_em: agoraIso,
                            },
                            ConditionExpression: "attribute_not_exists(intencao_id)",
                        },
                    },
                ],
            })
        )
    } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error
        return await explicarCancelamento(error, intencao, usuarioId)
    }

    // Lido depois da escrita: outra compra concorrente pode ter mudado o saldo
    // entre a pré-checagem e a transação.
    const depois = await buscarUsuario(usuarioId)

    const resposta: CompraAprovada = {
        status: "aprovado",
        transacao_id: transacaoId,
        intencao_id,
        valor: centavosParaReais(valor),
        metodo_pagamento: metodo,
        limite_restante: centavosParaReais(depois?.limite_disponivel_centavos ?? disponivel - valor),
        data: agoraIso,
    }
    return resposta
})

// Traduz o motivo do cancelamento da transação para o código de erro da Fase 1.
// A ordem importa: numa chamada duplicada a intenção ([0]) e a transação ([3])
// falham juntas, e a resposta certa é INTENCAO_JA_PAGA.
async function explicarCancelamento(
    error: TransactionCanceledException,
    intencao: Intencao,
    usuarioId: string
): Promise<Recusa> {
    const motivos = (error.CancellationReasons ?? []).map((m) => m?.Code)
    const falhou = (i: number) => motivos[i] === "ConditionalCheckFailed"

    if (falhou(0) || falhou(3)) {
        const atual = await buscarIntencao(intencao.intencao_id)
        if (atual?.status === "paga") return recusar("INTENCAO_JA_PAGA", MSG_JA_PAGA)
        if (atual && new Date(atual.expira_em).getTime() <= Date.now()) {
            return recusar("INTENCAO_EXPIRADA", MSG_EXPIRADA)
        }
        return recusar("INTENCAO_JA_PAGA", MSG_JA_PAGA)
    }

    if (falhou(1)) {
        const usuario = await buscarUsuario(usuarioId)
        return limiteExcedido(intencao, usuario?.limite_disponivel_centavos ?? 0)
    }

    if (falhou(2)) {
        const { Item: produto } = await ddb.send(
            new GetCommand({
                TableName: tabela("TABELA_PRODUTOS"),
                Key: { produto_id: intencao.produto_id },
                ConsistentRead: true,
            })
        )
        return estoqueInsuficiente(produto?.nome ?? "produto", produto?.estoque ?? 0, intencao.quantidade)
    }

    // TransactionConflict: outra transação mexia nos mesmos itens ao mesmo tempo.
    // Nada foi gravado; a compra pode ser tentada de novo.
    console.warn("[realizar_compra] transação cancelada sem falha de condição", motivos)
    return recusar(
        "FALHA_NA_FERRAMENTA",
        "Outra operação estava sendo processada ao mesmo tempo e nada foi cobrado. Tente pagar novamente."
    )
}
