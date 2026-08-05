import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved with fileURLToPath rather than URL.pathname: on Windows the latter yields
// "/C:/..." with a leading slash, which is not a usable filesystem path.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output copies only the files actually needed into .next/standalone,
  // which keeps the runtime container small — no node_modules layer to ship.
  output: 'standalone',
  // The workspace package ships compiled JS, but Next still needs to be told it is part
  // of the monorepo rather than an external dependency.
  transpilePackages: ['@saas/shared-types'],
  // The monorepo root, so tracing follows the workspace symlink into shared-types.
  outputFileTracingRoot: repoRoot,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
