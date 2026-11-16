import * as cdk from 'aws-cdk-lib'
import * as constructs from 'constructs'
import { Agente } from './agente.ts'
import { Api } from './api.ts'
import { Autenticacao } from './autenticacao.ts'
import { Dados } from './dados.ts'
import { Frontend } from './frontend.ts'
import { Tools } from './tools.ts'

export const ORIGEM_LOCAL = 'http://localhost:5173'

export type DesafioStackProps = cdk.StackProps & {
  prefixo: string
  frontend: boolean
  pastaDist?: string
}

export class DesafioStack extends cdk.Stack {
  constructor(scope: constructs.Construct, id: string, props: DesafioStackProps) {
    super(scope, id, props)
    const { prefixo } = props

    const dados = new Dados(this, 'Dados', { prefixo })
    const tools = new Tools(this, 'Tools', { prefixo, dados })
    const agente = new Agente(this, 'Agente', { prefixo, tools })

    const frontend = props.frontend ? new Frontend(this, 'Frontend', { prefixo }) : undefined
    const origemPermitida = frontend?.urlApp ?? ORIGEM_LOCAL

    const autenticacao = new Autenticacao(this, 'Autenticacao', { prefixo, urlApp: frontend?.urlApp })

    const api = new Api(this, 'Api', {
      prefixo,
      dados,
      autenticacao,
      agenteRuntimeArn: agente.runtimeArn,
      origemPermitida,
    })

    frontend?.publishSite(
      {
        urlApi: api.urlApi,
        regiao: this.region,
        userPoolId: autenticacao.userPool.userPoolId,
        userPoolClientId: autenticacao.userPoolClient.userPoolClientId,
      },
      props.pastaDist,
    )

    if (frontend) {
      new cdk.CfnOutput(this, 'UrlApp', { value: frontend.urlApp, description: 'Endereço público do site (CloudFront)' })
    }
    new cdk.CfnOutput(this, 'UrlApi', { value: api.urlApi, description: 'Base da API do webchat (API Gateway)' })
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: autenticacao.userPool.userPoolId,
      description: 'User pool do Cognito (criar usuários por convite)',
    })
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: autenticacao.userPoolClient.userPoolClientId,
      description: 'App client do frontend no Cognito',
    })
    new cdk.CfnOutput(this, 'AgentRuntimeArn', { value: agente.runtimeArn, description: 'Runtime do agente no AgentCore' })
    new cdk.CfnOutput(this, 'Regiao', { value: this.region, description: 'Região de todos os recursos' })
  }
}
