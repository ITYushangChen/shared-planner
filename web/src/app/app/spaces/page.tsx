import { redirect } from "next/navigation";
import { getAppAuth, getMySpaceNav, visibleSpaceNav } from "@/lib/app-data";
import { SpacesOverview } from "./spaces-overview";

export default async function SpacesPage() {
  const { user } = await getAppAuth();
  if (!user) redirect("/login");

  const { spaces } = await getMySpaceNav();
  const navSpaces = visibleSpaceNav(spaces);

  return <SpacesOverview spaces={navSpaces} />;
}
