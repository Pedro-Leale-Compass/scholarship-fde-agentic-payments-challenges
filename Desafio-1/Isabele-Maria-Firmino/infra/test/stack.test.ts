import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { DesafioStack, ORIGEM_LOCAL } from '../lib/stack.ts'
import { MODELO_BASE, PERFIL_MODELO, REGIOES_PERFIL } from '../lib/agente.ts'

type Recurso = { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string }
type Statement = { Effect: string; Action: string | string[]; Resource?: unknown; Principal?: any; Condition?: any }

const CONTEXTO = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')).context
const CONTA = '111122223333'
const ROLES_INTERNAS_CDK = /^(AWS679f53fac002430cb0da5b7982bd2287|CustomS3AutoDeleteObjects|CustomCDKBucketDeployment)/
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'

function createDistFalso(): string {
  const pasta = mkdtempSync(path.join(tmpdir(), 'dist-falso-'))
  mkdirSync(path.join(pasta, 'assets'))
  writeFileSync(path.join(pasta, 'index.html'), '<!doctype html><title>teste</title>')
  writeFileSync(path.join(pasta, 'assets', 'index-abc123.js'), 'console.log("teste")')
  return pasta
}

function createTemplate(frontend: boolean): Record<string, Recurso> {
  const app = new cdk.App({ context: CONTEXTO })
  const stack = new DesafioStack(app, 'DesafioStack', {
    stackName: 'isabele-desafio-1',
    prefixo: 'isabele',
    frontend,
    pastaDist: frontend ? createDistFalso() : undefined,
    env: { account: CONTA, region: 'us-east-1' },
  })
  return Template.fromStack(stack).toJSON().Resources as Record<string, Recurso>
}

function getRecursos(recursos: Record<string, Recurso>, tipo: string): [string, Recurso][] {
  return Object.entries(recursos).filter(([, recurso]) => recurso.Type === tipo)
}

function describeAlvo(valor: unknown): string {
  if (typeof valor === 'string') return valor
  const objeto = valor as Record<string, any>
  if (objeto['Fn::GetAtt']) return String(objeto['Fn::GetAtt'][0]).replace(/[0-9A-F]{8}$/, '')
  if (objeto.Ref) return String(objeto.Ref).replace(/[0-9A-F]{8}$/, '')
  if (objeto['Fn::Join']) return objeto['Fn::Join'][1].map(describeAlvo).join(objeto['Fn::Join'][0])
  return JSON.stringify(objeto)
}

function getRoleId(recursos: Record<string, Recurso>, nomeRole: string): string {
  const encontrada = getRecursos(recursos, 'AWS::IAM::Role').find(([, role]) => role.Properties?.RoleName === nomeRole)
  assert.ok(encontrada, `role ${nomeRole} não encontrada`)
  return encontrada[0]
}

function getStatementsDaRole(recursos: Record<string, Recurso>, roleId: string): Statement[] {
  return getRecursos(recursos, 'AWS::IAM::Policy')
    .filter(([, politica]) => JSON.stringify(politica.Properties?.Roles ?? []).includes(`"${roleId}"`))
    .flatMap(([, politica]) => politica.Properties?.PolicyDocument.Statement as Statement[])
}

function getPermissoes(recursos: Record<string, Recurso>, nomeRole: string): string[] {
  const pares = getStatementsDaRole(recursos, getRoleId(recursos, nomeRole)).flatMap((statement) =>
    [statement.Action].flat().flatMap((acao) => [statement.Resource].flat().map((alvo) => `${acao} → ${describeAlvo(alvo)}`)),
  )
  return [...new Set(pares)].sort()
}

function getStatementsAllow(recursos: Record<string, Recurso>): Statement[] {
  return [...getRecursos(recursos, 'AWS::IAM::Policy'), ...getRecursos(recursos, 'AWS::S3::BucketPolicy')]
    .flatMap(([, politica]) => politica.Properties?.PolicyDocument.Statement as Statement[])
    .filter((statement) => statement.Effect === 'Allow')
}

describe('stack completa (deploy)', () => {
  let recursos: Record<string, Recurso>

  before(() => {
    recursos = createTemplate(true)
  })

  describe('IAM sem curinga', () => {
    it('nenhum Allow concede todas as ações ou todas as ações de um serviço', () => {
      for (const statement of getStatementsAllow(recursos)) {
        for (const acao of [statement.Action].flat()) {
          assert.doesNotMatch(acao, /^(\*|[a-z0-9-]+:\*)$/, `ação curinga: ${acao}`)
        }
      }
    })

    it('Resource "*" só aparece no ecr:GetAuthorizationToken', () => {
      for (const statement of getStatementsAllow(recursos)) {
        if ([statement.Resource].flat().includes('*')) {
          assert.deepEqual([statement.Action].flat(), ['ecr:GetAuthorizationToken'], JSON.stringify(statement))
        }
      }
    })

    it('roles da aplicação não têm políticas gerenciadas', () => {
      const rolesAplicacao = getRecursos(recursos, 'AWS::IAM::Role').filter(([, role]) =>
        String(role.Properties?.RoleName ?? '').startsWith('isabele-'),
      )
      assert.equal(rolesAplicacao.length, 6)
      for (const [id, role] of rolesAplicacao) {
        assert.deepEqual(role.Properties?.ManagedPolicyArns ?? [], [], id)
      }
    })

    it('políticas gerenciadas só nas roles internas do CDK e só a AWSLambdaBasicExecutionRole', () => {
      for (const [id, role] of getRecursos(recursos, 'AWS::IAM::Role')) {
        const gerenciadas = role.Properties?.ManagedPolicyArns ?? []
        if (gerenciadas.length === 0) continue
        assert.match(id, ROLES_INTERNAS_CDK, `role ${id} com política gerenciada`)
        for (const politica of gerenciadas) {
          assert.match(JSON.stringify(politica), /service-role\/AWSLambdaBasicExecutionRole/, id)
        }
      }
    })

    it('nenhuma menção a AdministratorAccess', () => {
      assert.equal(JSON.stringify(recursos).includes('AdministratorAccess'), false)
    })
  })

  describe('menor privilégio por componente', () => {
    it('listar_catalogo só faz Scan no catálogo', () => {
      assert.deepEqual(getPermissoes(recursos, 'isabele-listar-catalogo-lambda'), [
        'dynamodb:Scan → DadosCatalogo',
        'logs:CreateLogStream → ToolsListarCatalogoLogs',
        'logs:PutLogEvents → ToolsListarCatalogoLogs',
      ])
    })

    it('registrar_intencao lê o catálogo e grava intenções', () => {
      assert.deepEqual(getPermissoes(recursos, 'isabele-registrar-intencao-lambda'), [
        'dynamodb:GetItem → DadosCatalogo',
        'dynamodb:PutItem → DadosIntencoes',
        'logs:CreateLogStream → ToolsRegistrarIntencaoLogs',
        'logs:PutLogEvents → ToolsRegistrarIntencaoLogs',
      ])
    })

    it('realizar_compra tem só as ações da transação', () => {
      assert.deepEqual(getPermissoes(recursos, 'isabele-realizar-compra-lambda'), [
        'dynamodb:GetItem → DadosIntencoes',
        'dynamodb:GetItem → DadosUsuarios',
        'dynamodb:PutItem → DadosTransacoes',
        'dynamodb:PutItem → DadosUsuarios',
        'dynamodb:UpdateItem → DadosCatalogo',
        'dynamodb:UpdateItem → DadosIntencoes',
        'dynamodb:UpdateItem → DadosUsuarios',
        'logs:CreateLogStream → ToolsRealizarCompraLogs',
        'logs:PutLogEvents → ToolsRealizarCompraLogs',
      ])
    })

    it('Lambda do chat invoca o agente e usa só a tabela de conversas', () => {
      assert.deepEqual(getPermissoes(recursos, 'isabele-chat-lambda'), [
        'bedrock-agentcore:InvokeAgentRuntime → AgenteRuntime',
        'bedrock-agentcore:InvokeAgentRuntime → AgenteRuntime/*',
        'dynamodb:GetItem → DadosConversas',
        'dynamodb:UpdateItem → DadosConversas',
        'logs:CreateLogStream → ApiChatLogs',
        'logs:PutLogEvents → ApiChatLogs',
      ])
    })

    it('Lambda de conversas só lê a tabela de conversas', () => {
      assert.deepEqual(getPermissoes(recursos, 'isabele-conversas-lambda'), [
        'dynamodb:GetItem → DadosConversas',
        'dynamodb:Query → DadosConversas',
        'logs:CreateLogStream → ApiConversasLogs',
        'logs:PutLogEvents → ApiConversasLogs',
      ])
    })

    it('AgentCore invoca só o Haiku e as tools, sem acesso a tabelas', () => {
      const permissoes = getPermissoes(recursos, 'isabele-agentcore-runtime')

      assert.equal(permissoes.filter((permissao) => permissao.startsWith('dynamodb:')).length, 0)

      const alvosBedrock = new Set(
        permissoes.filter((permissao) => permissao.startsWith('bedrock:')).map((permissao) => permissao.split(' → ')[1]),
      )
      assert.deepEqual([...alvosBedrock].sort(), [
        `arn:aws:bedrock:us-east-1:${CONTA}:inference-profile/${PERFIL_MODELO}`,
        ...REGIOES_PERFIL.map((regiao) => `arn:aws:bedrock:${regiao}::foundation-model/${MODELO_BASE}`),
      ].sort())

      const alvosLambda = permissoes
        .filter((permissao) => permissao.startsWith('lambda:'))
        .map((permissao) => permissao.split(' → ')[1].replace(/:\*$/, ''))
      assert.deepEqual([...new Set(alvosLambda)].sort(), ['ToolsListarCatalogo', 'ToolsRealizarCompra', 'ToolsRegistrarIntencao'])

      for (const permissao of permissoes.filter((permissao) => permissao.startsWith('logs:'))) {
        assert.match(permissao, /\/aws\/bedrock-agentcore\/runtimes\/isabele_agente-\*/, permissao)
      }
    })
  })

  describe('frontend', () => {
    it('bucket bloqueia acesso público e não usa website hosting', () => {
      const [[, bucket]] = getRecursos(recursos, 'AWS::S3::Bucket')
      assert.deepEqual(bucket.Properties?.PublicAccessBlockConfiguration, {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      })
      assert.equal(bucket.Properties?.WebsiteConfiguration, undefined)
    })

    it('só o CloudFront desta distribuição lê o bucket, e só com HTTPS', () => {
      const [[, politica]] = getRecursos(recursos, 'AWS::S3::BucketPolicy')
      const statements = politica.Properties?.PolicyDocument.Statement as Statement[]

      for (const statement of statements.filter((item) => item.Effect === 'Allow')) {
        if (statement.Principal?.Service === 'cloudfront.amazonaws.com') {
          assert.deepEqual([statement.Action].flat(), ['s3:GetObject'])
          assert.match(describeAlvo(statement.Condition.StringEquals['AWS:SourceArn']), /distribution\/FrontendDistribuicao$/)
        } else {
          assert.match(describeAlvo(statement.Principal?.AWS), /^CustomS3AutoDeleteObjects/, JSON.stringify(statement))
        }
      }

      assert.ok(
        statements.some((item) => item.Effect === 'Deny' && item.Condition?.Bool?.['aws:SecureTransport'] === 'false'),
      )
    })

    it('CloudFront usa OAC, redireciona para HTTPS e não guarda o config.json em cache', () => {
      assert.equal(getRecursos(recursos, 'AWS::CloudFront::OriginAccessControl').length, 1)
      const [[, distribuicao]] = getRecursos(recursos, 'AWS::CloudFront::Distribution')
      const config = distribuicao.Properties?.DistributionConfig
      assert.equal(config.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https')
      const configJson = config.CacheBehaviors.find((comportamento: any) => comportamento.PathPattern === '/config.json')
      assert.equal(configJson.CachePolicyId, CACHING_DISABLED)
      assert.equal(configJson.ViewerProtocolPolicy, 'redirect-to-https')
    })

    it('a publicação não recebe a distribuição e a invalidação é separada', () => {
      const [[, publicacao]] = getRecursos(recursos, 'Custom::CDKBucketDeployment')
      assert.equal(publicacao.Properties?.DistributionId, undefined)
      assert.ok(getRecursos(recursos, 'Custom::AWS').some(([id]) => id.startsWith('FrontendInvalidacaoCache')))
    })
  })

  describe('Cognito', () => {
    it('só administrador cria usuários', () => {
      const [[, userPool]] = getRecursos(recursos, 'AWS::Cognito::UserPool')
      assert.equal(userPool.Properties?.AdminCreateUserConfig.AllowAdminCreateUserOnly, true)
    })

    it('app client sem segredo e só com SRP', () => {
      const [[, cliente]] = getRecursos(recursos, 'AWS::Cognito::UserPoolClient')
      assert.equal(cliente.Properties?.GenerateSecret, false)
      assert.deepEqual([...cliente.Properties?.ExplicitAuthFlows].sort(), ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH'])
    })
  })

  describe('API Gateway', () => {
    it('toda rota real exige o Cognito e o preflight não', () => {
      const metodos = getRecursos(recursos, 'AWS::ApiGateway::Method')
      assert.equal(metodos.filter(([, metodo]) => metodo.Properties?.HttpMethod !== 'OPTIONS').length, 3)
      for (const [id, metodo] of metodos) {
        const esperado = metodo.Properties?.HttpMethod === 'OPTIONS' ? 'NONE' : 'COGNITO_USER_POOLS'
        assert.equal(metodo.Properties?.AuthorizationType, esperado, id)
      }
    })

    it('POST /chat usa streaming', () => {
      const [[, chat]] = getRecursos(recursos, 'AWS::ApiGateway::Method').filter(
        ([, metodo]) => metodo.Properties?.HttpMethod === 'POST',
      )
      assert.equal(chat.Properties?.Integration.ResponseTransferMode, 'STREAM')
      assert.match(JSON.stringify(chat.Properties?.Integration.Uri), /response-streaming-invocations/)
    })

    it('API regional com throttling no stage', () => {
      const [[, api]] = getRecursos(recursos, 'AWS::ApiGateway::RestApi')
      assert.deepEqual(api.Properties?.EndpointConfiguration.Types, ['REGIONAL'])
      const [[, stage]] = getRecursos(recursos, 'AWS::ApiGateway::Stage')
      assert.deepEqual(stage.Properties?.MethodSettings[0].ThrottlingRateLimit, 5)
      assert.deepEqual(stage.Properties?.MethodSettings[0].ThrottlingBurstLimit, 10)
    })

    it('respostas de erro do gateway liberam só a origem do CloudFront', () => {
      const respostas = getRecursos(recursos, 'AWS::ApiGateway::GatewayResponse')
      assert.equal(respostas.length, 2)
      for (const [, resposta] of respostas) {
        const origem = describeAlvo(resposta.Properties?.ResponseParameters['gatewayresponse.header.Access-Control-Allow-Origin'])
        assert.equal(origem, "'https://FrontendDistribuicao'")
      }
    })

    it('só o API Gateway invoca as Lambdas da API, uma permissão por rota', () => {
      const permissoes = getRecursos(recursos, 'AWS::Lambda::Permission')
      assert.equal(permissoes.length, 3)
      for (const [, permissao] of permissoes) assert.equal(permissao.Properties?.Principal, 'apigateway.amazonaws.com')
    })
  })

  describe('limpeza', () => {
    it('tabelas, bucket, user pool e log groups são apagados no destroy', () => {
      for (const tipo of ['AWS::DynamoDB::GlobalTable', 'AWS::S3::Bucket', 'AWS::Cognito::UserPool', 'AWS::Logs::LogGroup']) {
        const itens = getRecursos(recursos, tipo)
        assert.ok(itens.length > 0, tipo)
        for (const [id, item] of itens) assert.equal(item.DeletionPolicy, 'Delete', `${tipo} ${id}`)
      }
    })
  })
})

describe('stack só do backend (deploy:backend)', () => {
  let recursos: Record<string, Recurso>

  before(() => {
    recursos = createTemplate(false)
  })

  it('não cria bucket nem CloudFront', () => {
    assert.equal(getRecursos(recursos, 'AWS::S3::Bucket').length, 0)
    assert.equal(getRecursos(recursos, 'AWS::CloudFront::Distribution').length, 0)
  })

  it('libera o CORS para o frontend local', () => {
    for (const [, resposta] of getRecursos(recursos, 'AWS::ApiGateway::GatewayResponse')) {
      assert.equal(resposta.Properties?.ResponseParameters['gatewayresponse.header.Access-Control-Allow-Origin'], `'${ORIGEM_LOCAL}'`)
    }
    const chat = getRecursos(recursos, 'AWS::Lambda::Function').find(
      ([, funcao]) => funcao.Properties?.FunctionName === 'isabele-chat',
    )
    assert.equal(chat?.[1].Properties?.Environment.Variables.ORIGEM_PERMITIDA, ORIGEM_LOCAL)
  })
})
