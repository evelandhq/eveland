export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-7 md:px-8 md:py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account and this Eveland workspace.</p>
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  )
}
