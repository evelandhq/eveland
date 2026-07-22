export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-5 py-10">
      {children}
    </main>
  );
}
