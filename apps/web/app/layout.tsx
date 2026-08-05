import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { SessionProvider } from './session-provider';
import { Header } from '../components/header';

export const metadata: Metadata = {
  title: 'Multi-tenant SaaS platform',
  description:
    'Demo of a pooled multi-tenant application with PostgreSQL row-level security enforcing isolation.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <Header />
          <main className="shell">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
