import { ProfileSettingsForm } from "@/components/profile-settings-form";
import { getCurrentMember } from "@/lib/server-api";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Profile",
};

export default async function ProfileSettingsPage() {
  const member = await getCurrentMember();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">Profile</h2>
        <p className="text-sm text-muted-foreground">
          Update how you appear in Eveland and secure your account.
        </p>
      </header>
      <ProfileSettingsForm member={member} />
    </div>
  );
}
