import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { createAmbienteTeste, type AmbienteTeste } from './apoio.ts'
import { registerIntencao } from '../src/register-intencao.ts'
import {
  LIMITE_PADRAO_CENTS,
  createCompra,
  ensureUsuario,
  handler,
  parseLimitePadrao,
  type CompraAprovada,
  type RecusaCompra,
} from '../src/create-compra.ts'
import { ERRO_INTERNO } from '../src/shared/resposta.ts'

const USUARIO = 'usuario-teste'
const OUTRO_USUARIO = 'outro-usuario'
const CONVERSA = randomUUID()
const AGORA = new Date('2026-11-15T12:00:00.000Z')
const DEPOIS = new Date('2026-11-15T12:01:00.000Z')
const VENCIMENTO = new Date('2026-11-15T12:05:00.000Z')
const ID_TRANSACAO = /^tx_[0-9a-f]{16}$/

const INVALIDA = {
  status: 'recusado',
  erro: 'INTENCAO_INVALIDA',
  mensagem: 'Intenção inválida para o usuário autenticado.',
}
const SEM_ESTOQUE = {
  status: 'recusado',
  erro: 'INTENCAO_INVALIDA',
  mensagem: 'O estoque desta intenção não está mais disponível. Registre uma nova intenção.',
}
const JA_PAGA = { status: 'recusado', erro: 'INTENCAO_JA_PAGA', mensagem: 'Esta intenção de compra já foi utilizada.' }
const EXPIRADA = {
  status: 'recusado',
  erro: 'INTENCAO_EXPIRADA',
  mensagem: 'Esta intenção de compra expirou. Registre uma nova intenção.',
}
const METODO = {
  status: 'recusado',
  erro: 'METODO_INVALIDO',
  mensagem: 'Método de pagamento inválido. Escolha cartao ou pix.',
}
const LIMITE = { status: 'recusado', erro: 'LIMITE_EXCEDIDO', mensagem: 'O valor da compra excede o limite restante.' }

function assertAprovada(resposta: CompraAprovada | RecusaCompra): asserts resposta is CompraAprovada {
  assert.equal(resposta.status, 'aprovado', JSON.stringify(resposta))
}

describe('realizar_compra', () => {
  let ambiente: AmbienteTeste

  const register = async (produtoId: string, quantidade = 1, usuario = USUARIO, conversa = CONVERSA, agora = AGORA) => {
    const resposta = await registerIntencao(
      ambiente.db,
      { catalogo: ambiente.tabelas.catalogo, intencoes: ambiente.tabelas.intencoes },
      usuario,
      conversa,
      { produto_id: produtoId, quantidade },
      agora,
    )
    assert.ok('intencao_id' in resposta, JSON.stringify(resposta))
    return resposta.intencao_id
  }

  const pay = (
    intencaoId: unknown,
    metodo: unknown,
    opcoes: { usuario?: string; conversa?: string; agora?: Date; limite?: number } = {},
  ) =>
    createCompra(
      ambiente.db,
      ambiente.tabelas,
      opcoes.usuario ?? USUARIO,
      opcoes.conversa ?? CONVERSA,
      { intencao_id: intencaoId, metodo_pagamento: metodo },
      opcoes.agora ?? DEPOIS,
      opcoes.limite ?? LIMITE_PADRAO_CENTS,
    )

  const getItem = async (tabela: string, chave: Record<string, string>) => {
    const { Item } = await ambiente.db.send(new GetCommand({ TableName: tabela, Key: chave, ConsistentRead: true }))
    return Item
  }

  const countTransacoes = async () => {
    const { Count } = await ambiente.db.send(
      new ScanCommand({ TableName: ambiente.tabelas.transacoes, Select: 'COUNT', ConsistentRead: true }),
    )
    return Count ?? 0
  }

  const updateEstoque = (produtoId: string, estoque: number) =>
    ambiente.db.send(
      new UpdateCommand({
        TableName: ambiente.tabelas.catalogo,
        Key: { produto_id: produtoId },
        UpdateExpression: 'SET estoque = :estoque',
        ExpressionAttributeValues: { ':estoque': estoque },
      }),
    )

  const getSaldo = async (usuario = USUARIO) =>
    (await getItem(ambiente.tabelas.usuarios, { usuario_id: usuario }))?.saldo_cents

  beforeEach(async () => {
    ambiente = await createAmbienteTeste()
  })

  afterEach(async () => {
    delete process.env.TABELA_USUARIOS
    delete process.env.TABELA_CATALOGO
    delete process.env.TABELA_INTENCOES
    delete process.env.TABELA_TRANSACOES
    delete process.env.LIMITE_PADRAO_CENTS
    await ambiente.deleteAmbienteTeste()
  })

  describe('aprovações', () => {
    it('aprova a compra com cartão e devolve o contrato da Fase 1', async () => {
      const intencaoId = await register('prod_001')

      const resposta = await pay(intencaoId, 'cartao')

      assertAprovada(resposta)
      assert.match(resposta.transacao_id, ID_TRANSACAO)
      assert.deepEqual(resposta, {
        status: 'aprovado',
        transacao_id: resposta.transacao_id,
        intencao_id: intencaoId,
        valor: 249.9,
        metodo_pagamento: 'cartao',
        limite_restante: 750.1,
        data: DEPOIS.toISOString(),
      })
    })

    it('acumula o limite entre compras com cartão e pix', async () => {
      const fone = await pay(await register('prod_001'), 'cartao')
      const mochila = await pay(await register('prod_005'), 'pix')

      assertAprovada(fone)
      assertAprovada(mochila)
      assert.equal(fone.limite_restante, 750.1)
      assert.equal(mochila.limite_restante, 560.2)
      assert.equal(mochila.metodo_pagamento, 'pix')
    })

    it('grava a transação, baixa o estoque e marca a intenção como paga', async () => {
      const intencaoId = await register('prod_001')

      const resposta = await pay(intencaoId, 'pix')

      assertAprovada(resposta)
      assert.deepEqual(await getItem(ambiente.tabelas.transacoes, { transacao_id: resposta.transacao_id }), {
        transacao_id: resposta.transacao_id,
        intencao_id: intencaoId,
        usuario_id: USUARIO,
        valor_cents: 24990,
        metodo_pagamento: 'pix',
        data: DEPOIS.toISOString(),
      })
      assert.equal((await getItem(ambiente.tabelas.catalogo, { produto_id: 'prod_001' }))?.estoque, 19)
      const intencao = await getItem(ambiente.tabelas.intencoes, { intencao_id: intencaoId })
      assert.equal(intencao?.status, 'paga')
      assert.equal(intencao?.transacao_id, resposta.transacao_id)
    })
  })

  describe('limite', () => {
    it('recusa com LIMITE_EXCEDIDO quando o saldo acumulado não cobre e não altera nada', async () => {
      await pay(await register('prod_001'), 'cartao')
      await pay(await register('prod_005'), 'pix')
      const cadeira = await register('prod_004')

      const resposta = await pay(cadeira, 'cartao')

      assert.deepEqual(resposta, LIMITE)
      assert.equal(await getSaldo(), 56020)
      assert.equal(await countTransacoes(), 2)
      assert.equal((await getItem(ambiente.tabelas.intencoes, { intencao_id: cadeira }))?.status, 'pendente')
      assert.equal((await getItem(ambiente.tabelas.catalogo, { produto_id: 'prod_004' }))?.estoque, 5)
    })

    it('recusa o Monitor sozinho por passar do limite', async () => {
      const resposta = await pay(await register('prod_003'), 'pix')

      assert.deepEqual(resposta, LIMITE)
      assert.equal(await getSaldo(), LIMITE_PADRAO_CENTS)
    })

    it('respeita o limite padrão configurado', async () => {
      const resposta = await pay(await register('prod_001'), 'cartao', { limite: 20000 })

      assert.deepEqual(resposta, LIMITE)
      assert.equal(await getSaldo(), 20000)
    })
  })

  describe('intenção inválida', () => {
    it('recusa intencao_id inventado, vazio ou que não é texto', async () => {
      for (const intencaoId of ['int_falsa123', 'int_aprovada', '', undefined, 42]) {
        assert.deepEqual(await pay(intencaoId, 'pix'), INVALIDA, `intencao_id: ${JSON.stringify(intencaoId)}`)
      }
      assert.equal(await countTransacoes(), 0)
    })

    it('recusa intenção de outro usuário', async () => {
      const intencaoId = await register('prod_001', 1, OUTRO_USUARIO)

      assert.deepEqual(await pay(intencaoId, 'cartao'), INVALIDA)
      assert.equal(await countTransacoes(), 0)
    })

    it('recusa intenção de outra conversa do mesmo usuário e mantém a original pagável', async () => {
      const intencaoId = await register('prod_001')

      assert.deepEqual(await pay(intencaoId, 'cartao', { conversa: randomUUID() }), INVALIDA)
      assertAprovada(await pay(intencaoId, 'cartao'))
    })

    it('recusa intenção já paga com INTENCAO_JA_PAGA sem cobrar de novo', async () => {
      const intencaoId = await register('prod_001')
      assertAprovada(await pay(intencaoId, 'cartao'))

      assert.deepEqual(await pay(intencaoId, 'pix'), JA_PAGA)
      assert.equal(await countTransacoes(), 1)
      assert.equal(await getSaldo(), 75010)
    })

    it('recusa intenção no instante do vencimento com INTENCAO_EXPIRADA', async () => {
      const intencaoId = await register('prod_001')

      assert.deepEqual(await pay(intencaoId, 'cartao', { agora: VENCIMENTO }), EXPIRADA)
      assert.equal(await countTransacoes(), 0)
    })

    it('recusa método fora do contrato com METODO_INVALIDO sem criar o usuário', async () => {
      const intencaoId = await register('prod_001')

      for (const metodo of ['boleto', 'PIX', undefined]) {
        assert.deepEqual(await pay(intencaoId, metodo), METODO, `metodo: ${JSON.stringify(metodo)}`)
      }
      assert.equal((await getItem(ambiente.tabelas.intencoes, { intencao_id: intencaoId }))?.status, 'pendente')
      assert.equal(await getItem(ambiente.tabelas.usuarios, { usuario_id: USUARIO }), undefined)
    })
  })

  describe('estoque', () => {
    it('cancela a intenção quando o estoque acaba antes do pagamento', async () => {
      const intencaoId = await register('prod_004')
      await updateEstoque('prod_004', 0)

      assert.deepEqual(await pay(intencaoId, 'cartao'), SEM_ESTOQUE)
      assert.equal((await getItem(ambiente.tabelas.intencoes, { intencao_id: intencaoId }))?.status, 'cancelada_estoque')
      assert.equal(await countTransacoes(), 0)
      assert.equal(await getSaldo(), LIMITE_PADRAO_CENTS)
      assert.equal((await getItem(ambiente.tabelas.catalogo, { produto_id: 'prod_004' }))?.estoque, 0)

      await updateEstoque('prod_004', 5)
      assert.deepEqual(await pay(intencaoId, 'cartao'), SEM_ESTOQUE)
    })
  })

  describe('concorrência', () => {
    it('aprova só um de 5 pagamentos simultâneos da mesma intenção', async () => {
      const intencaoId = await register('prod_001')

      const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => pay(intencaoId, 'cartao')))

      const aprovados = resultados.filter((r) => r.status === 'fulfilled' && r.value.status === 'aprovado')
      const demais = resultados.filter((r) => !(r.status === 'fulfilled' && r.value.status === 'aprovado'))
      assert.equal(aprovados.length, 1, JSON.stringify(resultados))
      for (const resultado of demais) {
        if (resultado.status === 'fulfilled') assert.deepEqual(resultado.value, JA_PAGA)
      }
      assert.equal(await countTransacoes(), 1)
      assert.equal(await getSaldo(), 75010)
      assert.equal((await getItem(ambiente.tabelas.catalogo, { produto_id: 'prod_001' }))?.estoque, 19)
    })

    it('não deixa duas compras simultâneas passarem do limite', async () => {
      const cadeira = await register('prod_004')
      const teclado = await register('prod_002')

      const resultados = await Promise.allSettled([pay(cadeira, 'cartao'), pay(teclado, 'pix')])

      const aprovados = resultados.flatMap((r) =>
        r.status === 'fulfilled' && r.value.status === 'aprovado' ? [r.value] : [],
      )
      assert.equal(aprovados.length, 1, JSON.stringify(resultados))
      for (const resultado of resultados) {
        if (resultado.status === 'fulfilled' && resultado.value.status !== 'aprovado') {
          assert.deepEqual(resultado.value, LIMITE)
        }
      }
      assert.equal(await countTransacoes(), 1)
      assert.equal(await getSaldo(), LIMITE_PADRAO_CENTS - Math.round(aprovados[0].valor * 100))
    })
  })

  describe('usuário', () => {
    it('cria o usuário com limite cheio e não reseta o saldo depois', async () => {
      await ensureUsuario(ambiente.db, ambiente.tabelas.usuarios, USUARIO, LIMITE_PADRAO_CENTS, AGORA)
      assert.deepEqual(await getItem(ambiente.tabelas.usuarios, { usuario_id: USUARIO }), {
        usuario_id: USUARIO,
        limite_cents: LIMITE_PADRAO_CENTS,
        saldo_cents: LIMITE_PADRAO_CENTS,
        criado_em: AGORA.toISOString(),
      })

      await ambiente.db.send(
        new UpdateCommand({
          TableName: ambiente.tabelas.usuarios,
          Key: { usuario_id: USUARIO },
          UpdateExpression: 'SET saldo_cents = :saldo',
          ExpressionAttributeValues: { ':saldo': 5000 },
        }),
      )
      await ensureUsuario(ambiente.db, ambiente.tabelas.usuarios, USUARIO, LIMITE_PADRAO_CENTS, DEPOIS)

      assert.equal(await getSaldo(), 5000)
    })

    it('lê o limite padrão da configuração e recusa valores inválidos', () => {
      assert.equal(parseLimitePadrao(undefined), LIMITE_PADRAO_CENTS)
      assert.equal(parseLimitePadrao(' '), LIMITE_PADRAO_CENTS)
      assert.equal(parseLimitePadrao('50000'), 50000)
      for (const valor of ['-5', 'abc', '1.5']) {
        assert.throws(() => parseLimitePadrao(valor), Error, `valor: ${valor}`)
      }
    })
  })

  describe('handler', () => {
    beforeEach(() => {
      process.env.TABELA_USUARIOS = ambiente.tabelas.usuarios
      process.env.TABELA_CATALOGO = ambiente.tabelas.catalogo
      process.env.TABELA_INTENCOES = ambiente.tabelas.intencoes
      process.env.TABELA_TRANSACOES = ambiente.tabelas.transacoes
    })

    it('compra pelo handler com as 4 tabelas das variáveis de ambiente', async () => {
      const intencaoId = await register('prod_005', 1, USUARIO, CONVERSA, new Date())

      const resposta = await handler({
        usuario_id: USUARIO,
        conversa_id: CONVERSA,
        argumentos: { intencao_id: intencaoId, metodo_pagamento: 'pix' },
      })

      assert.ok('status' in resposta)
      assert.equal(resposta.status, 'aprovado')
      assert.equal(await countTransacoes(), 1)
    })

    it('recusa LIMITE_PADRAO_CENTS inválido com ERRO_INTERNO', async (t) => {
      const log = t.mock.method(console, 'error', () => {})
      process.env.LIMITE_PADRAO_CENTS = 'abc'
      const intencaoId = await register('prod_005', 1, USUARIO, CONVERSA, new Date())

      const resposta = await handler({
        usuario_id: USUARIO,
        conversa_id: CONVERSA,
        argumentos: { intencao_id: intencaoId, metodo_pagamento: 'pix' },
      })

      assert.deepEqual(resposta, ERRO_INTERNO)
      assert.equal(log.mock.callCount(), 1)
      assert.equal(await countTransacoes(), 0)
    })

    it('recusa chamada sem usuario_id com ERRO_INTERNO', async (t) => {
      t.mock.method(console, 'error', () => {})
      const intencaoId = await register('prod_005', 1, USUARIO, CONVERSA, new Date())

      const resposta = await handler({
        conversa_id: CONVERSA,
        argumentos: { intencao_id: intencaoId, metodo_pagamento: 'pix' },
      })

      assert.deepEqual(resposta, ERRO_INTERNO)
      assert.equal(await countTransacoes(), 0)
    })

    it('recusa chamada sem conversa_id com ERRO_INTERNO', async (t) => {
      t.mock.method(console, 'error', () => {})
      const intencaoId = await register('prod_005', 1, USUARIO, CONVERSA, new Date())

      const resposta = await handler({
        usuario_id: USUARIO,
        argumentos: { intencao_id: intencaoId, metodo_pagamento: 'pix' },
      })

      assert.deepEqual(resposta, ERRO_INTERNO)
      assert.equal(await countTransacoes(), 0)
    })
  })
})
