import type { ToolExecutada } from '../api.ts'

export type StatusTool = 'aprovado' | 'recusado' | 'neutro'

function getCampo(resultado: unknown, campo: string): string | undefined {
  if (typeof resultado !== 'object' || resultado === null) return undefined
  const valor = (resultado as Record<string, unknown>)[campo]
  return typeof valor === 'string' ? valor : undefined
}

export function getStatusTool(resultado: unknown): StatusTool {
  const status = getCampo(resultado, 'status')
  if (status === 'aprovado') return 'aprovado'
  if (status === 'recusado' || status === 'erro') return 'recusado'
  return 'neutro'
}

export function getRotulo(resultado: unknown): string {
  return getCampo(resultado, 'erro') ?? getCampo(resultado, 'status') ?? ''
}

export function formatJson(valor: unknown): string {
  return JSON.stringify(valor, null, 2) ?? 'null'
}

export default function PainelTools({ tools }: { tools: ToolExecutada[] }) {
  if (tools.length === 0) return null

  return (
    <section className="painel-tools" aria-label="Ferramentas executadas">
      {tools.map((tool, indice) => {
        const rotulo = getRotulo(tool.resultado)
        return (
          <details key={indice} className={`tool tool-${getStatusTool(tool.resultado)}`}>
            <summary>
              <code>{tool.nome}</code>
              {rotulo && <span className="tool-rotulo">{rotulo}</span>}
            </summary>
            <div className="tool-corpo">
              <h4>Argumentos enviados pelo modelo</h4>
              <pre>{formatJson(tool.argumentos)}</pre>
              <h4>Resposta do backend</h4>
              <pre>{formatJson(tool.resultado)}</pre>
            </div>
          </details>
        )
      })}
    </section>
  )
}
