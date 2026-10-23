import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CRUM Console',
  description: 'Conversational CRM workbench',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
