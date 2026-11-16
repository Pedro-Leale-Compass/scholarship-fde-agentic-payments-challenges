import type { DemoProfile } from '../types/auth'
// Metadados opcionais de exibição; nunca armazenam senhas ou autorizações.
export const demoProfiles: DemoProfile[] = [
  {
    name: 'Maria Alyce',
    label: 'VIP',
    limit: 15000,
    username: 'cliente_vip',
  },
  {
    name: 'Pedro Leale',
    label: 'Padrão',
    limit: 2000,
    username: 'cliente_padrao',
  },
  {
    name: 'Gabriel Missio',
    label: 'Limite reduzido',
    limit: 100,
    username: 'cliente_sem_saldo',
  },
]
