import { Suspense } from "react";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { getAppAuth, getMySpaceNav, visibleSpaceNav } from "@/lib/app-data";

// 资料板块工作区是重客户端组件（Markdown 编辑/预览 + 附件），拆为独立 chunk，
// 进入 /app/docs 时先出 SSR HTML，客户端 JS 并行异步加载，降低首屏 TTI。
const DocsWorkspace = dynamic(
  () => import("./docs-workspace").then((m) => ({ default: m.DocsWorkspace })),
);

export default async function DocsPage() {
  const { user } = await getAppAuth();

  if (!user) {
    redirect("/login");
  }

  const { spaces: allSpaces } = await getMySpaceNav();
  const spaces = visibleSpaceNav(allSpaces);

  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={null}>
        <DocsWorkspace spaces={spaces} />
      </Suspense>
    </main>
  );
}
