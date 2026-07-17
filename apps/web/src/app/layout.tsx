import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';
import { Inter } from 'next/font/google';
import { cn } from '@/lib/utils';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Eveland',
  description: 'Self-hosted eve runtime control plane',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn('font-sans', inter.variable)}>
      <body>
        <TooltipProvider>
          <AppShell>{children}</AppShell>
        </TooltipProvider>
      </body>
    </html>
  );
}
