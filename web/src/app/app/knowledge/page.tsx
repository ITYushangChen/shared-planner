import { Suspense } from "react";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { getAppAuth, getMySpaceNav, visibleSpaceNav } from "@/lib/app-data";

// 知识板块工作区是重客户端组件（连接知识源 + 拆解问题 + 展示方案），拆为独立 chunk，
// 进入 /app/knowledge 时先出 SSR HTML，客户端 JS 并行异步加载，降低首屏 TTI。
const KnowledgeWorkspace = dynamic(
  () =>
    import("./knowledge-workspace").then((m) => ({
      default: m.KnowledgeWorkspace,
    })),
);

export default async function KnowledgePage() {
  const { user } = await getAppAuth();

  if (!user) {
    redirect("/login");
  }

  const { spaces: allSpaces } = await getMySpaceNav();
  const spaces = visibleSpaceNav(allSpaces);

  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={null}>
        <KnowledgeWorkspace spaces={spaces} />
      </Suspense>
    </main>
  );
}
