import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // postgres-js is a native-ish driver; keep it out of the bundler's traversal.
  serverExternalPackages: ['postgres'],
}

export default nextConfig
