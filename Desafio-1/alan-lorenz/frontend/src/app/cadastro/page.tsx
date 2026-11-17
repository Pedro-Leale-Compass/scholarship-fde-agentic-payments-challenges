'use client'

import Link from 'next/link'
import AuthCard from '@/components/auth/AuthCard'

export default function CadastroPage() {
  return (
    <AuthCard
      title="Acesso gerenciado"
      subtitle="As contas são criadas pela equipe do desafio"
      footer={
        <>
          Já recebeu um convite?{' '}
          <Link
            href="/login"
            className="font-semibold text-white underline underline-offset-2 hover:text-uol-yellow transition-colors"
          >
            Faça login
          </Link>
        </>
      }
    >
      <p className="text-sm leading-6 text-white/80">
        O cadastro público está desativado. Peça à coordenação para criar sua
        conta; você receberá por e-mail um convite com uma senha temporária e
        poderá definir sua senha no primeiro acesso.
      </p>
    </AuthCard>
  )
}
