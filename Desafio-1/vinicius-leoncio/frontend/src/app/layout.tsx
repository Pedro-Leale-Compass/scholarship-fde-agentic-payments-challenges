import type { Metadata } from "next";
import "@aws-amplify/ui-react/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chat de Pagamentos",
  description: "Assistente de vendas da loja",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

