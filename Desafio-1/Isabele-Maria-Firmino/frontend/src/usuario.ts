export function getInicial(email?: string): string {
  const letra = email?.trim().charAt(0)
  return letra ? letra.toLocaleUpperCase('pt-BR') : '?'
}
