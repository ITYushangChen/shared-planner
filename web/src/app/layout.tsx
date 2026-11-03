import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // 品牌名统一为 SharedPlanner（此前 title 是遗留的 ShareTodo AI，
  // 与仓库名、页面内文案都不一致）
  title: "SharedPlanner · 共享日程与待办协作",
  description: "共享日程与待办协作，支持空间协作、日历排期与进度报告",
  appleWebApp: {
    capable: true,
    title: "SharedPlanner",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 不再禁用缩放：maximumScale:1 违反 WCAG 1.4.4，弱视用户无法放大页面
  viewportFit: "cover",
  themeColor: "#b7bbbd",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[var(--background,#fff)] text-[var(--foreground)]">
        {children}
      </body>
    </html>
  );
}
