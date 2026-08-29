/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages (@dagents/shared, @dagents/contracts, …) are ESM-only. Next
  // transpiles them so the server runtime can import them without a separate
  // build step.
  transpilePackages: ['@dagents/shared', '@dagents/contracts', '@dagents/agentflow'],
  reactStrictMode: true,
  // 关闭 dev 浮动指示器：它停靠左下角，与侧栏页脚（设置/主题/语言）重叠
  // 并拦截指针事件 —— e2e 点击「设置」被 nextjs-portal 遮挡（2026-08-29
  // Workflow-First IA 的 UC-NAV-07 定位）。仅影响 dev，生产无此浮层。
  devIndicators: false,
  // Standalone build: bundles a self-contained server.js + only the node_modules
  // it traces, under .next/standalone. Required for the Docker image, which
  // copies that server (not the full node_modules) into the runtime stage.
  output: 'standalone',
  // The repo is a pnpm workspace with its own lockfile; the host home dir
  // also has a pnpm-lock.yaml, which makes Next infer the wrong workspace
  // root (and trace the whole home dir). Pin tracing to the monorepo root so
  // only the files this app actually uses ship with the build.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
}

export default nextConfig
