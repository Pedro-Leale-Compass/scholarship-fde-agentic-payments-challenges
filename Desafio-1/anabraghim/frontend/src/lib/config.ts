// Configuração lida em tempo de execução de /config.json, gerado pelo deploy.sh a
// partir dos Outputs da stack (F9). Assim o mesmo build serve para qualquer
// ambiente e nenhum id fica fixo no código. Não há segredo aqui: o app client do
// Cognito é público (sem secret).
//
// A API não precisa de URL: ela responde em /api na mesma origem (CloudFront).
export interface ConfigApp {
    userPoolId: string
    userPoolClientId: string
}

const USER_POOL_ID = /^[a-z]{2}-[a-z]+-\d_[0-9A-Za-z]+$/
const CLIENT_ID = /^[0-9a-z]{20,128}$/

export async function carregarConfig(buscar: typeof fetch = fetch): Promise<ConfigApp> {
    const resposta = await buscar("/config.json", { cache: "no-store" })
    if (!resposta.ok) throw new Error(`config.json indisponível (HTTP ${resposta.status})`)
    const dados = (await resposta.json()) as Partial<Record<keyof ConfigApp, unknown>>
    const { userPoolId, userPoolClientId } = dados
    if (typeof userPoolId !== "string" || !USER_POOL_ID.test(userPoolId)) {
        throw new Error("config.json sem userPoolId válido")
    }
    if (typeof userPoolClientId !== "string" || !CLIENT_ID.test(userPoolClientId)) {
        throw new Error("config.json sem userPoolClientId válido")
    }
    return { userPoolId, userPoolClientId }
}
