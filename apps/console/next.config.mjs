/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages (@mil/shared, @mil/contracts, …) are ESM-only. Next
  // transpiles them so the server runtime can import them without a separate
  // build step.
  transpilePackages: ['@mil/shared', '@mil/contracts'],
  reactStrictMode: true,
  // The repo is a pnpm workspace with its own lockfile; the host home dir
  // also has a pnpm-lock.yaml, which makes Next infer the wrong workspace
  // root (and trace the whole home dir). Pin tracing to the monorepo root so
  // only the files this app actually uses ship with the build.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
}

export default nextConfig
