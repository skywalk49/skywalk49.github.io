import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "<周杰/>",
  description: "除了前端我什么都不会",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
