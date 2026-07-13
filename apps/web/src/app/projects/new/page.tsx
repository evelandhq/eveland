import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { NewProjectForms } from '@/components/new-project-forms';
import { cn } from '@/lib/utils';

export default function NewProjectPage() {
  return (
    <div className="min-h-[calc(100svh-3rem)] bg-background">
      <header className="flex h-14 items-center gap-3 border-b border-border px-6">
        <Link href="/projects" className={cn(buttonVariants({ variant: 'ghost' }))}>
          <ArrowLeftIcon data-icon="inline-start" />
          Projects
        </Link>
        <h1 className="text-base font-semibold">New project</h1>
      </header>

      <NewProjectForms />
    </div>
  );
}
