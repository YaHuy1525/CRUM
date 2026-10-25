'use client'

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { Toaster } from '@/components/ui/sonner'

/**
 * Client-side providers for the whole console. §"Approved decisions" 4
 * (TanStack Query owns server state) and §"Design system foundation" (toasts
 * report mutation outcomes).
 *
 * The `QueryClient` is created in a lazy `useState` initializer so each browser
 * tab gets one stable client across re-renders, and so server rendering never
 * shares a client between requests. Defaults are conservative: a short
 * `staleTime` and no refetch-on-focus, because the console reads governed CRM
 * and approval data that should not silently re-fetch behind a user's back.
 *
 * The sonner `Toaster` lives here so any page can fire a toast without mounting
 * its own.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster />
    </QueryClientProvider>
  )
}
