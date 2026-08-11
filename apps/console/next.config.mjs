/** @type {import('next').NextConfig} */
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const nextConfig = {
  // Workspace packages (@dagents/shared, @dagents/contracts, …) are ESM-only. Next
  // transpiles them so the server runtime can import them without a separate
  // build step.
  transpilePackages: ['@dagents/shared', '@dagents/contracts', '@dagents/agentflow'],
  reactStrictMode: true,
  // Standalone build: bundles a self-contained server.js + only the node_modules
  // it traces, under .next/standalone. Required for the Docker image, which
  // copies that server (not the full node_modules) into the runtime stage.
  output: 'standalone',
  // The repo is a pnpm workspace with its own lockfile; the host home dir
  // also has a pnpm-lock.yaml, which makes Next infer the wrong workspace
  // root (and trace the whole home dir). Pin tracing to the monorepo root so
  // only the files this app actually uses ship with the build.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  webpack: (config) => {
    config.resolve.alias['@agentflow'] = path.resolve(__dirname, '../../vendor/agentflow/src')
    return config
  },
}

export default nextConfig
