import type { NextConfig } from "next";

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
