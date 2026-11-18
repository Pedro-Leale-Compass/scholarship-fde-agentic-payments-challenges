'use client';

import type { AuthUser } from 'aws-amplify/auth';

import { UserMenu } from '@/components/user-menu';

type AppHeaderProps = {
  user: AuthUser;
  onSignOut: () => void;
};

export function AppHeader({ user, onSignOut }: AppHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border">
      <span className="truncate text-sm font-semibold">Agente de Pagamentos</span>
      <UserMenu user={user} onSignOut={onSignOut} />
    </header>
  );
}
