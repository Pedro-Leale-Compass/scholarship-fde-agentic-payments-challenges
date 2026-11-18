'use client';

import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';

import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

type ThemeToggleProps = {
  iconOnly?: boolean;
  asMenuItem?: boolean;
};

export function ThemeToggle({ iconOnly = false, asMenuItem = false }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';
  const label = isDark ? 'Tema claro' : 'Tema escuro';
  const Icon = isDark ? SunIcon : MoonIcon;

  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      {iconOnly ? null : <span>{label}</span>}
    </>
  );

  if (asMenuItem) {
    return (
      <DropdownMenuItem
        className="cursor-pointer"
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
      >
        {content}
      </DropdownMenuItem>
    );
  }

  return (
    <Button
      variant="ghost"
      size={iconOnly ? 'icon-sm' : 'sm'}
      className={iconOnly ? undefined : 'w-full justify-start gap-2'}
      aria-label={label}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {content}
    </Button>
  );
}
