import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Conditional class joiner with Tailwind conflict resolution.
 *
 * `clsx` handles the conditional/object/array shapes; `twMerge` collapses
 * conflicting Tailwind utilities so a later class wins deterministically
 * (e.g. `cn('p-4', 'p-2')` -> `p-2`). Every shadcn primitive routes its
 * `className` through this so callers can override variant spacing safely.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
