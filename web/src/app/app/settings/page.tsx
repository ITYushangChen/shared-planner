import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAppAuth, getMySpaceNav, visibleSpaceNav } from "@/lib/app-data";
import { SettingsWorkspace } from "./settings-workspace";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const { supabase, user } = await getAppAuth();

  if (!user) {
    redirect("/login");
  }

  const { spaces: allSpaces, spacePrefsById } = await getMySpaceNav();
  const spaces = visibleSpaceNav(allSpaces);

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "display_name, timezone, email, avatar_url, ui_prefs, notification_prefs",
    )
    .eq("id", user.id)
    .maybeSingle();

  const email = user.email ?? profile?.email ?? "";

  return (
    <Suspense fallback={null}>
      <SettingsWorkspace
        email={email}
        displayName={profile?.display_name ?? ""}
        timezone={profile?.timezone ?? "Asia/Shanghai"}
        avatarUrl={profile?.avatar_url ?? ""}
        spaceCount={spaces.length}
        globalPrefsRaw={profile?.ui_prefs}
        spacePrefsByIdRaw={spacePrefsById}
        notificationPrefsRaw={profile?.notification_prefs}
        spaces={spaces}
      />
    </Suspense>
  );
}
