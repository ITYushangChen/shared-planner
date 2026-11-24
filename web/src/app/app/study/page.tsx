import { Suspense } from "react";
import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { getAppAuth, getMySpaceNav, visibleSpaceNav } from "@/lib/app-data";

// 学习计划工作区是重客户端组件（目录核对 + 排期预览 + 计划进度），拆为独立 chunk，
// 进入 /app/study 时先出 SSR HTML，客户端 JS 并行异步加载，降低首屏 TTI。
const StudyWorkspace = dynamic(
  () => import("./study-workspace").then((m) => ({ default: m.StudyWorkspace })),
);

export default async function StudyPage() {
  const { user } = await getAppAuth();

  if (!user) {
    redirect("/login");
  }

  const { spaces: allSpaces } = await getMySpaceNav();
  const spaces = visibleSpaceNav(allSpaces);

  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={null}>
        <StudyWorkspace spaces={spaces} />
      </Suspense>
    </main>
  );
}
