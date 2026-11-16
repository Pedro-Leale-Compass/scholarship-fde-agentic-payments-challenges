// Ícones em SVG embutido: sem biblioteca extra e sem depender de CDN (a CSP só libera 'self').

interface Props {
    tamanho?: number
}

const base = (tamanho: number) => ({
    width: tamanho,
    height: tamanho,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
})

export function IconeSacola({ tamanho = 20 }: Props) {
    return (
        <svg {...base(tamanho)}>
            <path d="M6 7h12l1 13H5L6 7Z" />
            <path d="M9 10V6a3 3 0 0 1 6 0v4" />
        </svg>
    )
}

export function IconeBrilho({ tamanho = 16 }: Props) {
    return (
        <svg {...base(tamanho)}>
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
        </svg>
    )
}

export function IconeEnviar({ tamanho = 20 }: Props) {
    return (
        <svg {...base(tamanho)}>
            <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
    )
}

export function IconeSair({ tamanho = 18 }: Props) {
    return (
        <svg {...base(tamanho)}>
            <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
            <path d="M10 17l5-5-5-5M15 12H4" />
        </svg>
    )
}

export function IconeFerramenta({ tamanho = 16 }: Props) {
    return (
        <svg {...base(tamanho)}>
            <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4 2.5-2.5Z" />
        </svg>
    )
}
