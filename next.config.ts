import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'doc',
  basePath: process.env.PAGES_BASE_PATH,
}

export default nextConfig
