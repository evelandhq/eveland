import { redirect } from "next/navigation";

export default async function SecretProfilesSettingsPage() {
  redirect("/settings/shared-agent-environment");
}
