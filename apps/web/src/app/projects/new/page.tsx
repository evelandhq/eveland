import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NewProjectForms } from '@/components/new-project-forms';

export default function NewProjectPage() {
  return (
    <main className="min-h-screen bg-background">
      <header className="flex h-14 items-center gap-3 border-b border-border px-6">
        <Link href="/projects">
          <ArrowLeftIcon data-icon="inline-start" />
          Projects
        </Link>
        <h1 className="text-base font-semibold">New project</h1>
      </header>

      <NewProjectForms />
    </main>
  );
}
