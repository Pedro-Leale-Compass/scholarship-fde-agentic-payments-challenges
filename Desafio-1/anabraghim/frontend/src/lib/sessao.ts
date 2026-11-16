import { fetchAuthSession } from "aws-amplify/auth"
import { NaoAutenticadoError } from "./api"

// ID token da sessão atual. O Amplify renova com o refresh token quando o token
// expira (1 h); sem sessão válida, quem chama faz logout.
export async function obterTokenId(): Promise<string> {
    const sessao = await fetchAuthSession()
    const token = sessao.tokens?.idToken?.toString()
    if (!token) throw new NaoAutenticadoError()
    return token
}
