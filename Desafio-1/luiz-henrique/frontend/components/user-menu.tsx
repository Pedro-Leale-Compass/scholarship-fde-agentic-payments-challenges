'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchUserAttributes, type AuthUser } from 'aws-amplify/auth';
import { ChevronDownIcon, LogOutIcon } from 'lucide-react';

import { ThemeToggle } from '@/components/theme-toggle';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function initials(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (trimmed === '') return '?';
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export function getUserName(user: AuthUser, attributes?: Record<string, string>): string {
  return (
    attributes?.name ??
    attributes?.email ??
    user.signInDetails?.loginId ??
    user.username ??
    ''
  );
}

export function getUserEmail(user: AuthUser, attributes?: Record<string, string>): string {
  return attributes?.email ?? user.signInDetails?.loginId ?? '';
}

type UserMenuProps = {
  user: AuthUser;
  onSignOut: () => void;
};

export function UserMenu({ user, onSignOut }: UserMenuProps) {
  const [attributes, setAttributes] = useState<Record<string, string>>({});

  useEffect(() => {
    let mounted = true;
    fetchUserAttributes()
      .then((result) => {
        if (mounted) setAttributes(result as Record<string, string>);
      })
      .catch(() => {
        // atributos são opcionais; loginId/username servem de fallback
      });
    return () => {
      mounted = false;
    };
  }, []);

  const name = getUserName(user, attributes);
  const email = getUserEmail(user, attributes);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto gap-2 py-1.5 pl-2 pr-1.5"
          aria-label="Abrir menu do usuário"
        >
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="hidden max-w-32 truncate text-sm font-medium sm:inline">
            {firstName(name)}
          </span>
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block truncate font-medium text-foreground">{name}</span>
            <span className="block truncate text-sm font-normal">{email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/">Home</Link>
          </DropdownMenuItem>
          <ThemeToggle asMenuItem />
          <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
            <LogOutIcon />
            Sair
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
