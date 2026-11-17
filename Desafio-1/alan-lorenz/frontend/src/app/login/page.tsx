'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { confirmSignIn, signIn } from 'aws-amplify/auth'
import { AUTH_MESSAGE_KEY, configureCognito } from '@/lib/auth/cognito'
import AuthCard from '@/components/auth/AuthCard'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [trocaSenhaObrigatoria, setTrocaSenhaObrigatoria] = useState(false)
  const [mostrarSenha, setMostrarSenha] = useState(false)
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(false)

  useEffect(() => {
    const message = sessionStorage.getItem(AUTH_MESSAGE_KEY)
    if (message) {
      setErro(message)
      sessionStorage.removeItem(AUTH_MESSAGE_KEY)
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErro('')
    setCarregando(true)

    try {
      await configureCognito()
      const result = trocaSenhaObrigatoria
        ? await confirmSignIn({ challengeResponse: senha })
        : await signIn({ username: email.trim(), password: senha })

      if (result.isSignedIn) {
        router.replace('/')
        return
      }

      if (
        result.nextStep.signInStep ===
        'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED'
      ) {
        setTrocaSenhaObrigatoria(true)
        setSenha('')
        setErro('Crie uma nova senha para concluir o primeiro acesso.')
        return
      }

      setErro('A conta exige uma etapa de autenticação não configurada.')
    } catch (err) {
      const name =
        typeof err === 'object' && err !== null && 'name' in err
          ? err.name
          : undefined
      if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
        setErro('E-mail ou senha inválidos.')
      } else {
        setErro(
          trocaSenhaObrigatoria
            ? 'Não foi possível atualizar a senha. Confira os requisitos e tente novamente.'
            : 'Não foi possível entrar. Verifique a conexão e tente novamente.',
        )
        console.error(err)
      }
    } finally {
      setCarregando(false)
    }
  }

  return (
    <AuthCard
      title="Bem-vindo de volta"
      subtitle="Entre para continuar suas compras"
      footer={
        <>
          Precisa de uma conta?{' '}
          <Link
            href="/cadastro"
            className="font-semibold text-white underline underline-offset-2 hover:text-uol-yellow transition-colors"
          >
            Saiba como solicitar
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {!trocaSenhaObrigatoria && (
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700 mb-1.5 dark:text-gray-300"
            >
              E-mail
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={carregando}
              placeholder="voce@exemplo.com"
              className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:border-uol-blue focus:ring-2 focus:ring-uol-blue/30 outline-none transition disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
            />
          </div>
        )}

        <div>
          <label
            htmlFor="senha"
            className="block text-sm font-medium text-gray-700 mb-1.5 dark:text-gray-300"
          >
            {trocaSenhaObrigatoria ? 'Nova senha' : 'Senha'}
          </label>
          <div className="relative">
            <input
              id="senha"
              type={mostrarSenha ? 'text' : 'password'}
              autoComplete={
                trocaSenhaObrigatoria ? 'new-password' : 'current-password'
              }
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
              minLength={trocaSenhaObrigatoria ? 8 : undefined}
              disabled={carregando}
              placeholder="••••••••"
              className="w-full px-4 py-3 pr-24 rounded-lg border border-gray-300 bg-white text-gray-900 placeholder-gray-400 focus:border-uol-blue focus:ring-2 focus:ring-uol-blue/30 outline-none transition disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
            />
            <button
              type="button"
              onClick={() => setMostrarSenha((value) => !value)}
              disabled={carregando}
              aria-label={mostrarSenha ? 'Ocultar senha' : 'Mostrar senha'}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1.5 text-sm font-medium text-uol-blue hover:bg-uol-blue/10 rounded-md transition"
            >
              {mostrarSenha ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
        </div>

        {erro && (
          <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <span aria-hidden="true">⚠</span>
            <span>{erro}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={carregando}
          className="w-full py-3 rounded-lg font-semibold text-white bg-uol-blue hover:bg-uol-blue-dark focus:ring-4 focus:ring-uol-blue/30 transition disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {carregando
            ? trocaSenhaObrigatoria
              ? 'Atualizando senha...'
              : 'Entrando...'
            : trocaSenhaObrigatoria
              ? 'Definir senha'
              : 'Entrar'}
        </button>
      </form>
    </AuthCard>
  )
}
