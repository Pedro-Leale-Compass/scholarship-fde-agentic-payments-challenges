import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { createAmbienteTeste, type AmbienteTeste } from './apoio.ts'
import { handler, listCatalogo } from '../src/list-catalogo.ts'
import { ERRO_INTERNO } from '../src/shared/resposta.ts'

const USUARIO = 'usuario-teste'

describe('listar_catalogo', () => {
  let ambiente: AmbienteTeste

  beforeEach(async () => {
    ambiente = await createAmbienteTeste()
  })

  afterEach(async () => {
    delete process.env.TABELA_CATALOGO
    await ambiente.deleteAmbienteTeste()
  })

  describe('listCatalogo', () => {
    it('lista os 5 produtos ordenados por id', async () => {
      const { produtos } = await listCatalogo(ambiente.db, ambiente.tabelas.catalogo, {})
      assert.deepEqual(
        produtos.map((produto) => produto.id),
        ['prod_001', 'prod_002', 'prod_003', 'prod_004', 'prod_005'],
      )
    })

    it('devolve o contrato da Fase 1 com preço em reais', async () => {
      const { produtos } = await listCatalogo(ambiente.db, ambiente.tabelas.catalogo, {})
      assert.deepEqual(produtos[0], {
        id: 'prod_001',
        nome: 'Fone Bluetooth',
        preco: 249.9,
        moeda: 'BRL',
        estoque: 20,
      })
    })

    it('filtra por categoria ignorando maiúsculas e espaços', async () => {
      const { produtos } = await listCatalogo(ambiente.db, ambiente.tabelas.catalogo, { categoria: ' Monitores ' })
      assert.deepEqual(
        produtos.map((produto) => produto.id),
        ['prod_003'],
      )
    })

    it('devolve lista vazia para categoria inexistente', async () => {
      const resposta = await listCatalogo(ambiente.db, ambiente.tabelas.catalogo, { categoria: 'jardinagem' })
      assert.deepEqual(resposta, { produtos: [] })
    })

    it('ignora categoria que não é texto', async () => {
      const { produtos } = await listCatalogo(ambiente.db, ambiente.tabelas.catalogo, { categoria: 42 })
      assert.equal(produtos.length, 5)
    })

    it('reflete o estoque atual da tabela', async () => {
      await ambiente.db.send(
        new UpdateCommand({
          TableName: ambiente.tabelas.catalogo,
          Key: { produto_id: 'prod_004' },
          UpdateExpression: 'SET estoque = :estoque',
          ExpressionAttributeValues: { ':estoque': 0 },
        }),
      )

      const { produtos } = await listCatalogo(ambiente.db, ambiente.tabelas.catalogo, {})
      assert.equal(produtos.find((produto) => produto.id === 'prod_004')?.estoque, 0)
    })
  })

  describe('handler', () => {
    it('responde pelo handler usando a tabela da variável de ambiente', async () => {
      process.env.TABELA_CATALOGO = ambiente.tabelas.catalogo

      const resposta = await handler({ usuario_id: USUARIO, argumentos: { categoria: 'audio' } })

      assert.deepEqual(resposta, {
        produtos: [{ id: 'prod_001', nome: 'Fone Bluetooth', preco: 249.9, moeda: 'BRL', estoque: 20 }],
      })
    })

    it('recusa chamada sem usuario_id com ERRO_INTERNO', async (t) => {
      const log = t.mock.method(console, 'error', () => {})
      process.env.TABELA_CATALOGO = ambiente.tabelas.catalogo

      const resposta = await handler({ argumentos: {} })

      assert.deepEqual(resposta, ERRO_INTERNO)
      assert.equal(log.mock.callCount(), 1)
    })
  })
})
