/** @type {import('next').NextConfig} */
const nextConfig = {
  // 隔离构建出口（2026-09-06 E-17）：dev server 运行时 `next build` 覆盖 .next
  // 会把 dev 打成全站 500 —— `NEXT_DIST_DIR=.next-build pnpm build:isolated`
  // 写到别处，dev 的 .next 原封不动（Dockerfile 构建走默认 .next 不受影响）。
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
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
  // 客户端 bundle 不解析 node 内建（2026-09-08）：canvas 页的 CANVAS_NODES
  // 元数据链会把 @dagents/workflow dist 拉进浏览器图，其中 CustomFunction 的
  // user-code-exec.ts 静态 import worker_threads —— 该代码只在网关侧执行，
  // 浏览器里永远不会 new Worker，置空模块即可（否则 canvas 全页 500：
  // Module not found: Can't resolve 'worker_threads'）。
  // 双路：webpack（next build / 裸 next dev）走下面的 fallback 置空；
  // Turbopack（pnpm dev 的 --turbopack）忽略 webpack() 配置，走 resolveAlias
  // 指到空模块替身（src/stubs/worker-threads-stub.js），两路等价。
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        'node:worker_threads': false,
        worker_threads: false,
      }
    }
    return config
  },
  turbopack: {
    resolveAlias: {
      worker_threads: './src/stubs/worker-threads-stub.js',
      'node:worker_threads': './src/stubs/worker-threads-stub.js',
    },
  },
  // The repo is a pnpm workspace with its own lockfile; the host home dir
  // also has a pnpm-lock.yaml, which makes Next infer the wrong workspace
  // root (and trace the whole home dir). Pin tracing to the monorepo root so
  // only the files this app actually uses ship with the build.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
}

export default nextConfig
