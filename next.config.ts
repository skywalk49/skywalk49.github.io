import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'docs',
  basePath: process.env.PAGES_BASE_PATH,
}

export default nextConfig
