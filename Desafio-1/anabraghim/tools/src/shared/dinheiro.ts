// Dinheiro é guardado e calculado em centavos inteiros. Só vira reais na saída,
// nos contratos das tools: evita o 4750.000000000001 que aparecia na Fase 1.
export function centavosParaReais(centavos: number): number {
    return Math.round(centavos) / 100
}

// Mesmo formato das mensagens da Fase 1: "BRL 918.00".
export function formatarValor(moeda: string, centavos: number): string {
    return `${moeda} ${centavosParaReais(centavos).toFixed(2)}`
}
