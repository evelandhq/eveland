"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRoundIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { changePassword, updateProfile, type CurrentMember } from "@/lib/client-api";

const avatarTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxAvatarBytes = 512 * 1024;

function currentBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function availableTimezones(): string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  const timezones = supportedValuesOf?.("timeZone") ?? [];
  return Array.from(new Set(["UTC", ...timezones])).sort();
}

export function ProfileSettingsForm({ member }: { member: CurrentMember }) {
  const router = useRouter();
  const [name, setName] = useState(member.name ?? member.email);
  const [image, setImage] = useState<string | null>(member.image);
  const [displayTimezone, setDisplayTimezone] = useState(member.displayTimezone ?? "");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profilePending, setProfilePending] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const initials = (name || member.email).slice(0, 2).toUpperCase();
  const timezoneOptions = useMemo(availableTimezones, []);

  useEffect(() => {
    if (!member.displayTimezone) setDisplayTimezone(currentBrowserTimezone());
  }, [member.displayTimezone]);

  function chooseAvatar(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setProfileSaved(false);
    setProfileError(null);
    if (!file) return;
    if (!avatarTypes.has(file.type)) {
      setProfileError("Choose a PNG, JPEG, or WebP image.");
      event.currentTarget.value = "";
      return;
    }
    if (file.size > maxAvatarBytes) {
      setProfileError("Avatar images must not exceed 512 KB.");
      event.currentTarget.value = "";
      return;
    }
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => setImage(typeof reader.result === "string" ? reader.result : null),
      { once: true },
    );
    reader.addEventListener("error", () => setProfileError("Could not read that image."), {
      once: true,
    });
    reader.readAsDataURL(file);
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfilePending(true);
    setProfileSaved(false);
    setProfileError(null);
    try {
      const updated = await updateProfile({ name, image, displayTimezone });
      setProfileSaved(true);
      window.dispatchEvent(new CustomEvent("eveland:profile-updated", { detail: updated }));
      router.refresh();
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : "Could not update your profile.");
    } finally {
      setProfilePending(false);
    }
  }

  async function savePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    setPasswordSaved(false);
    setPasswordError(null);
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }
    setPasswordPending(true);
    try {
      await changePassword(currentPassword, newPassword);
      form.reset();
      setPasswordSaved(true);
    } catch (caught) {
      setPasswordError(
        caught instanceof Error ? caught.message : "Could not change your password.",
      );
    } finally {
      setPasswordPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-9">
      <section className="flex flex-col gap-5" aria-labelledby="profile-details-heading">
        <div className="flex flex-col gap-1">
          <h3 id="profile-details-heading" className="text-base font-semibold">
            Profile details
          </h3>
          <p className="text-sm text-muted-foreground">
            Your name and avatar are visible to other workspace members.
          </p>
        </div>
        <form onSubmit={saveProfile} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="avatar">Avatar</FieldLabel>
              <div className="flex flex-wrap items-center gap-4">
                <Avatar className="size-16">
                  {image ? <AvatarImage src={image} alt={name || member.email} /> : null}
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <div className="flex flex-1 flex-col gap-2">
                  <Input
                    id="avatar"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={chooseAvatar}
                  />
                  <FieldDescription>PNG, JPEG, or WebP. Maximum 512 KB.</FieldDescription>
                </div>
                {image ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setImage(null)}>
                    <Trash2Icon data-icon="inline-start" />
                    Remove
                  </Button>
                ) : null}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                name="name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                maxLength={80}
                required
              />
            </Field>
            <Field data-disabled>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" type="email" value={member.email} disabled />
              <FieldDescription>Your sign-in email cannot be changed here.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="display-timezone">Display timezone</FieldLabel>
              <Select
                value={displayTimezone}
                onValueChange={(value) => setDisplayTimezone(value ?? "")}
              >
                <SelectTrigger id="display-timezone" className="w-full">
                  <SelectValue placeholder="Detecting your current timezone…" />
                </SelectTrigger>
                <SelectContent>
                  {timezoneOptions.map((timezone) => (
                    <SelectItem key={timezone} value={timezone}>
                      {timezone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                All dates and times in Eveland use this timezone. It defaults to your current
                browser timezone.
              </FieldDescription>
            </Field>
          </FieldGroup>
          {profileError ? (
            <Alert variant="destructive">
              <AlertDescription>{profileError}</AlertDescription>
            </Alert>
          ) : null}
          {profileSaved ? (
            <Alert>
              <AlertDescription>Profile saved.</AlertDescription>
            </Alert>
          ) : null}
          <div>
            <Button
              type="submit"
              className="rounded-full"
              disabled={profilePending || name.trim().length === 0 || displayTimezone.length === 0}
            >
              {profilePending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              {profilePending ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </form>
      </section>

      <Separator />

      <section className="flex flex-col gap-5" aria-labelledby="password-heading">
        <div className="flex flex-col gap-1">
          <h3 id="password-heading" className="text-base font-semibold">
            Password
          </h3>
          <p className="text-sm text-muted-foreground">
            Changing your password signs out every other active session.
          </p>
        </div>
        <form onSubmit={savePassword} className="flex flex-col gap-5">
          <FieldGroup>
            <Field data-invalid={Boolean(passwordError)}>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                aria-invalid={Boolean(passwordError)}
                required
              />
            </Field>
            <Field data-invalid={Boolean(passwordError)}>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                aria-invalid={Boolean(passwordError)}
                required
              />
              <FieldDescription>Use at least 12 characters.</FieldDescription>
            </Field>
            <Field data-invalid={Boolean(passwordError)}>
              <FieldLabel htmlFor="confirm-password">Confirm new password</FieldLabel>
              <Input
                id="confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                aria-invalid={Boolean(passwordError)}
                required
              />
              {passwordError ? <FieldError>{passwordError}</FieldError> : null}
            </Field>
          </FieldGroup>
          {passwordSaved ? (
            <Alert>
              <AlertDescription>Password changed. Other sessions were signed out.</AlertDescription>
            </Alert>
          ) : null}
          <div>
            <Button type="submit" className="rounded-full" disabled={passwordPending}>
              {passwordPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <KeyRoundIcon data-icon="inline-start" />
              )}
              {passwordPending ? "Changing…" : "Change password"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
