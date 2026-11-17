import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const NOME_STACK = 'isabele-desafio-1'
const REGIAO = 'us-east-1'
const ARQUIVO_OUTPUTS = fileURLToPath(new URL('../cdk-outputs.json', import.meta.url))
const ARQUIVO_CONFIG = fileURLToPath(new URL('../../frontend/public/config.json', import.meta.url))

type Outputs = Record<string, string>

function readOutputsArquivo(): Outputs | undefined {
  if (!existsSync(ARQUIVO_OUTPUTS)) return undefined
  const conteudo = JSON.parse(readFileSync(ARQUIVO_OUTPUTS, 'utf8')) as Record<string, Outputs>
  return conteudo[NOME_STACK]
}

function getOutputsCloudFormation(): Outputs {
  const saida = execFileSync(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      NOME_STACK,
      '--region',
      REGIAO,
      '--query',
      'Stacks[0].Outputs',
      '--output',
      'json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const lista = JSON.parse(saida) as { OutputKey: string; OutputValue: string }[] | null
  return Object.fromEntries((lista ?? []).map((output) => [output.OutputKey, output.OutputValue]))
}

function getOutput(outputs: Outputs, chave: string): string {
  const valor = outputs[chave]
  if (!valor) throw new Error(`o Output ${chave} não foi encontrado na stack ${NOME_STACK}: o deploy foi feito?`)
  return valor
}

function createConfigFrontend(): void {
  const doArquivo = readOutputsArquivo()
  const outputs = doArquivo ?? getOutputsCloudFormation()

  const config = {
    urlApi: getOutput(outputs, 'UrlApi'),
    regiao: getOutput(outputs, 'Regiao'),
    userPoolId: getOutput(outputs, 'UserPoolId'),
    userPoolClientId: getOutput(outputs, 'UserPoolClientId'),
  }

  writeFileSync(ARQUIVO_CONFIG, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`config.json gerado em ${ARQUIVO_CONFIG}`)
  console.log(`fonte: ${doArquivo ? ARQUIVO_OUTPUTS : `Outputs da stack ${NOME_STACK} (AWS CloudFormation)`}`)
  console.log(JSON.stringify(config, null, 2))
}

createConfigFrontend()
