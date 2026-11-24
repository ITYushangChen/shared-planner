import { redirect } from "next/navigation";

/**
 * 管理后台已并入设置页（/app/settings），本路由保留为兼容跳转：
 * 直接重定向到设置页的「账户管理」目录项。
 */
export default function AdminPage() {
  redirect("/app/settings?tab=admin-accounts");
}
