import { fileURLToPath } from 'node:url'
import * as cdk from 'aws-cdk-lib'
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore'
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as constructs from 'constructs'
import type { Tools } from './tools.ts'

export type AgenteProps = {
  prefixo: string
  tools: Tools
}

const PASTA_AGENT = fileURLToPath(new URL('../../agent', import.meta.url))

export const PERFIL_MODELO = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
export const MODELO_BASE = PERFIL_MODELO.replace(/^us\./, '')
export const REGIOES_PERFIL = ['us-east-1', 'us-east-2', 'us-west-2']

export class Agente extends constructs.Construct {
  readonly role: iam.Role
  readonly runtimeArn: string

  constructor(scope: constructs.Construct, id: string, props: AgenteProps) {
    super(scope, id)
    const stack = cdk.Stack.of(this)
    const nomeRuntime = `${props.prefixo}_agente`

    const imagem = new ecrAssets.DockerImageAsset(this, 'Imagem', {
      directory: PASTA_AGENT,
      platform: ecrAssets.Platform.LINUX_ARM64,
    })

    this.role = new iam.Role(this, 'Role', {
      roleName: `${props.prefixo}-agentcore-runtime`,
      description: 'Execução do agente Strands no AgentCore Runtime',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:*` },
        },
      }),
    })

    imagem.repository.grantPull(this.role)

    const logGroupsRuntime = `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/runtimes/${nomeRuntime}-*`
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LogGroupsDoRuntime',
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams'],
        resources: [logGroupsRuntime],
      }),
    )
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventosDeLogDoRuntime',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroupsRuntime}:log-stream:*`],
      }),
    )
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ModeloHaiku',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${PERFIL_MODELO}`,
          ...REGIOES_PERFIL.map((regiao) => `arn:aws:bedrock:${regiao}::foundation-model/${MODELO_BASE}`),
        ],
      }),
    )

    const { listarCatalogo, registrarIntencao, realizarCompra } = props.tools
    for (const funcao of [listarCatalogo, registrarIntencao, realizarCompra]) funcao.grantInvoke(this.role)

    const runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: nomeRuntime,
      description: 'Agente Strands de pagamentos (Claude Haiku 4.5)',
      agentRuntimeArtifact: { containerConfiguration: { containerUri: imagem.imageUri } },
      roleArn: this.role.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      environmentVariables: {
        LAMBDA_LISTAR_CATALOGO: listarCatalogo.functionName,
        LAMBDA_REGISTRAR_INTENCAO: registrarIntencao.functionName,
        LAMBDA_REALIZAR_COMPRA: realizarCompra.functionName,
        MODEL_ID: PERFIL_MODELO,
      },
    })
    runtime.node.addDependency(this.role)

    this.runtimeArn = runtime.attrAgentRuntimeArn
  }
}
