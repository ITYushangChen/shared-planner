import { redirect } from "next/navigation";

/** 旧入口：个人资料已并入统一设置页 */
export default function ProfileRedirect() {
  redirect("/app/settings?tab=profile");
}
