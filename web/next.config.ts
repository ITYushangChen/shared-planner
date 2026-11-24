import type { NextConfig } from "next";

// dev 环境 Next 的 chunk 走 eval-source-map，没有 'unsafe-eval' 浏览器会直接拒绝执行，
// 导致 React 不水合（表现为「页面能看但点了没反应、useEffect 不跑」）。生产构建不含 eval。
const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 允许局域网 IP / Cloudflare 隧道在开发模式下加载 /_next 资源
  allowedDevOrigins: ["*.trycloudflare.com", "10.88.12.34"],
  experimental: {
    optimizePackageImports: [
      "@fullcalendar/core",
      "@fullcalendar/react",
      "@fullcalendar/daygrid",
      "@fullcalendar/timegrid",
      "@fullcalendar/interaction",
      // 体积大且稳定，开启 barrel 优化做 tree-shake，减小首屏打包体积
      "@supabase/supabase-js",
      "@supabase/ssr",
    ],
  },
  // 静态产物长效缓存：业务代码更新后浏览器可复用 vendor chunk，二次访问首屏更快。
  // 注意只匹配 /_next/static 与 /_next/image，绝不覆盖页面 HTML（带 auth 的页面不缓存）。
  async headers() {
    return [
      // ⚠️ 安全响应头（2026-11-02 补）：此前一个都没有，缺 CSP / 点击劫持 / MIME 嗅探防护。
      // 说明：本站需要连 Supabase（同源 /supabase 反代）与加载用户自定义头像 URL，
      // 所以 CSP 的 img-src 放行 https: 与 data:，connect-src 用 'self' 即可走同源反代。
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // 内联样式：Tailwind 与 FullCalendar 运行时注入 <style>，必须放行
              "style-src 'self' 'unsafe-inline'",
              // Next 需要内联启动脚本；AI/图表等未引入外部脚本，不放 unsafe-eval
              // （dev 例外：eval-source-map 需要 unsafe-eval，否则完全不水合）
              isDev
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
                : "script-src 'self' 'unsafe-inline'",
              // 头像可以是任意 https 地址，也允许 data: 预览
              "img-src 'self' data: https: blob:",
              // 同源 /supabase 反代 + 后端 API
              "connect-src 'self' https:",
              "font-src 'self' data:",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/_next/image/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  // 仅 webpack 构建生效（Turbopack 会忽略）。把体积大且稳定的依赖拆成独立 vendor chunk，
  // 业务代码迭代时这些 chunk 哈希不变、可被浏览器长期复用。
  webpack: (config) => {
    config.optimization = config.optimization || {};
    const prev = config.optimization.splitChunks as
      | { cacheGroups?: Record<string, unknown> }
      | undefined;
    config.optimization.splitChunks = {
      ...(config.optimization.splitChunks || {}),
      cacheGroups: {
        ...(prev?.cacheGroups || {}),
        supabaseVendor: {
          test: /[\\/]node_modules[\\/]@supabase[\\/]/,
          name: "supabase-vendor",
          chunks: "all",
          priority: 20,
        },
        fullcalendarVendor: {
          test: /[\\/]node_modules[\\/]@fullcalendar[\\/]/,
          name: "fullcalendar-vendor",
          chunks: "all",
          priority: 20,
        },
      },
    };
    return config;
  },
};

export default nextConfig;
