import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'docs',
  trailingSlash: true
}

export default nextConfig
