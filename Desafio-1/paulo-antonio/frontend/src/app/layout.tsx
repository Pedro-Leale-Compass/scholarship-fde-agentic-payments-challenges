import type { Metadata } from 'next';
import '@aws-amplify/ui-react/styles.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agente de pagamentos',
  description: 'Ambiente de demonstração de compras simuladas.',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
