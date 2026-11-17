import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { createAmbienteTeste, type AmbienteTeste } from './apoio.ts'
import { handler, registerIntencao } from '../src/register-intencao.ts'
import { ERRO_INTERNO } from '../src/shared/resposta.ts'

const USUARIO = 'usuario-teste'
const CONVERSA = randomUUID()
const AGORA = new Date('2026-11-15T12:00:00.000Z')
const EXPIRA_EM = '2026-11-15T12:05:00.000Z'
const ID_INTENCAO = /^int_[0-9a-f]{12}$/

describe('registrar_intencao', () => {
  let ambiente: AmbienteTeste

  const register = (args: Record<string, unknown>) =>
    registerIntencao(
      ambiente.db,
      { catalogo: ambiente.tabelas.catalogo, intencoes: ambiente.tabelas.intencoes },
      USUARIO,
      CONVERSA,
      args,
      AGORA,
    )

  const countIntencoes = async () => {
    const { Count } = await ambiente.db.send(
      new ScanCommand({ TableName: ambiente.tabelas.intencoes, Select: 'COUNT' }),
    )
    return Count ?? 0
  }

  beforeEach(async () => {
    ambiente = await createAmbienteTeste()
  })

  afterEach(async () => {
    delete process.env.TABELA_CATALOGO
    delete process.env.TABELA_INTENCOES
    await ambiente.deleteAmbienteTeste()
  })

  describe('registerIntencao', () => {
    it('registra a intenção e devolve o contrato da Fase 1', async () => {
      const resposta = await register({ produto_id: 'prod_001', quantidade: 2 })

      assert.ok('intencao_id' in resposta)
      assert.match(resposta.intencao_id, ID_INTENCAO)
      assert.deepEqual(resposta, {
        intencao_id: resposta.intencao_id,
        produto_id: 'prod_001',
        quantidade: 2,
        valor_total: 499.8,
        moeda: 'BRL',
        status: 'pendente',
        expira_em: EXPIRA_EM,
        valido_por_minutos: 5,
      })
    })

    it('grava dono, conversa e valor em centavos na tabela', async () => {
      const resposta = await register({ produto_id: 'prod_001', quantidade: 2 })
      assert.ok('intencao_id' in resposta)

      const { Item } = await ambiente.db.send(
        new GetCommand({ TableName: ambiente.tabelas.intencoes, Key: { intencao_id: resposta.intencao_id } }),
      )

      assert.deepEqual(Item, {
        intencao_id: resposta.intencao_id,
        usuario_id: USUARIO,
        conversa_id: CONVERSA,
        produto_id: 'prod_001',
        quantidade: 2,
        valor_total_cents: 49980,
        moeda: 'BRL',
        status: 'pendente',
        criada_em: AGORA.toISOString(),
        expira_em: EXPIRA_EM,
      })
    })

    it('não expõe usuario_id nem conversa_id na resposta', async () => {
      const resposta = await register({ produto_id: 'prod_001', quantidade: 1 })

      assert.equal('usuario_id' in resposta, false)
      assert.equal('conversa_id' in resposta, false)
    })

    it('gera um id diferente a cada registro', async () => {
      const primeira = await register({ produto_id: 'prod_001', quantidade: 1 })
      const segunda = await register({ produto_id: 'prod_001', quantidade: 1 })

      assert.ok('intencao_id' in primeira && 'intencao_id' in segunda)
      assert.notEqual(primeira.intencao_id, segunda.intencao_id)
      assert.equal(await countIntencoes(), 2)
    })

    it('não reserva estoque ao registrar', async () => {
      await register({ produto_id: 'prod_001', quantidade: 3 })

      const { Item } = await ambiente.db.send(
        new GetCommand({ TableName: ambiente.tabelas.catalogo, Key: { produto_id: 'prod_001' } }),
      )
      assert.equal(Item?.estoque, 20)
    })

    it('recusa produto inexistente com PRODUTO_INEXISTENTE', async () => {
      for (const produtoId of ['prod_999', 'Fone Bluetooth', '', 42]) {
        const resposta = await register({ produto_id: produtoId, quantidade: 1 })
        assert.deepEqual(
          resposta,
          { status: 'recusado', erro: 'PRODUTO_INEXISTENTE', mensagem: 'Produto não encontrado no catálogo.' },
          `produto_id: ${JSON.stringify(produtoId)}`,
        )
      }
      assert.equal(await countIntencoes(), 0)
    })

    it('recusa quantidade inválida com QUANTIDADE_INVALIDA', async () => {
      for (const quantidade of [0, -1, 1.5, '2', undefined, 2 ** 53]) {
        const resposta = await register({ produto_id: 'prod_001', quantidade })
        assert.deepEqual(
          resposta,
          {
            status: 'recusado',
            erro: 'QUANTIDADE_INVALIDA',
            mensagem: 'Quantidade deve ser um inteiro maior que zero.',
          },
          `quantidade: ${JSON.stringify(quantidade)}`,
        )
      }
      assert.equal(await countIntencoes(), 0)
    })

    it('recusa quantidade acima do estoque com ESTOQUE_INSUFICIENTE', async () => {
      const resposta = await register({ produto_id: 'prod_004', quantidade: 6 })

      assert.deepEqual(resposta, {
        status: 'recusado',
        erro: 'ESTOQUE_INSUFICIENTE',
        mensagem: 'Estoque insuficiente para a quantidade solicitada.',
      })
      assert.equal(await countIntencoes(), 0)
    })

    it('aceita exatamente o estoque disponível', async () => {
      const resposta = await register({ produto_id: 'prod_004', quantidade: 5 })

      assert.ok('status' in resposta)
      assert.equal(resposta.status, 'pendente')
    })
  })

  describe('handler', () => {
    beforeEach(() => {
      process.env.TABELA_CATALOGO = ambiente.tabelas.catalogo
      process.env.TABELA_INTENCOES = ambiente.tabelas.intencoes
    })

    it('registra pelo handler com as tabelas das variáveis de ambiente', async () => {
      const resposta = await handler({
        usuario_id: USUARIO,
        conversa_id: CONVERSA,
        argumentos: { produto_id: 'prod_005', quantidade: 1 },
      })

      assert.ok('status' in resposta)
      assert.equal(resposta.status, 'pendente')
      assert.equal(await countIntencoes(), 1)
    })

    it('recusa chamada sem conversa_id com ERRO_INTERNO', async (t) => {
      const log = t.mock.method(console, 'error', () => {})

      const resposta = await handler({ usuario_id: USUARIO, argumentos: { produto_id: 'prod_005', quantidade: 1 } })

      assert.deepEqual(resposta, ERRO_INTERNO)
      assert.equal(log.mock.callCount(), 1)
      assert.equal(await countIntencoes(), 0)
    })

    it('recusa conversa_id que não é UUID v4 com ERRO_INTERNO', async (t) => {
      t.mock.method(console, 'error', () => {})

      const resposta = await handler({
        usuario_id: USUARIO,
        conversa_id: 'conversa-1',
        argumentos: { produto_id: 'prod_005', quantidade: 1 },
      })

      assert.deepEqual(resposta, ERRO_INTERNO)
      assert.equal(await countIntencoes(), 0)
    })
  })
})
