import { Fragment, type ReactNode } from 'react'

/**
 * Converte marcações inline simples (**negrito**, `código`, *itálico*) em nós React
 * seguros, evitando qualquer injeção de HTML bruto.
 */
export function renderInline(text: string): ReactNode {
  const tokenRegex = /(\*\*[^*\n]+?\*\*|`[^`\n]+?`|\*[^*\n]+?\*)/g
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    } else {
      nodes.push(token)
    }

    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes.length === 1 ? nodes[0] : nodes
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim())
}

function isHeading(line: string): boolean {
  return /^#{1,3}\s+/.test(line.trim())
}

function isHorizontalRule(line: string): boolean {
  return /^(-{3,}|\*{3,})$/.test(line.trim())
}

function isUnorderedItem(line: string): boolean {
  return /^\s*[-*•]\s+/.test(line)
}

function isOrderedItem(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line)
}

/**
 * Converte subconjunto seguro de Markdown usado pelo assistente em elementos JSX.
 */
export function renderMarkdown(content: string): ReactNode {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const current = lines[i]
    const trimmed = current.trim()

    if (!trimmed) {
      i++
      continue
    }

    if (isHorizontalRule(trimmed)) {
      blocks.push(<hr key={key++} className="md-hr" />)
      i++
      continue
    }

    if (isHeading(trimmed)) {
      const headingText = trimmed.replace(/^#{1,3}\s+/, '')
      blocks.push(
        <h4 key={key++} className="md-heading">
          {renderInline(headingText)}
        </h4>,
      )
      i++
      continue
    }

    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = splitTableRow(trimmed)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(splitTableRow(lines[i]))
        i++
      }

      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((header, idx) => (
                  <th key={idx}>{renderInline(header)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  {headers.map((_, colIdx) => (
                    <td key={colIdx}>{renderInline(row[colIdx] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    if (isUnorderedItem(current)) {
      const items: string[] = []
      while (i < lines.length && isUnorderedItem(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (isOrderedItem(current)) {
      const items: string[] = []
      while (i < lines.length && isOrderedItem(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key++} className="md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>,
      )
      continue
    }

    const paragraphLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !isHorizontalRule(lines[i].trim()) &&
      !isHeading(lines[i].trim()) &&
      !isUnorderedItem(lines[i]) &&
      !isOrderedItem(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paragraphLines.push(lines[i])
      i++
    }

    blocks.push(
      <p key={key++} className="md-paragraph">
        {paragraphLines.map((line, idx) => (
          <Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInline(line)}
          </Fragment>
        ))}
      </p>,
    )
  }

  return blocks
}
