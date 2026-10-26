'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Pencil, RotateCw, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  deleteThread,
  describeError,
  listThreads,
  renameThread,
  searchThreads,
} from '@/lib/api'
import type { ThreadsResponse } from '@/lib/types'
import { relativeTime } from '@/lib/time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'


const UNTITLED = 'Untitled conversation'

function titleOf(row: { title: string | null }): string {
  return row.title?.trim() ? row.title : UNTITLED
}

export function ConversationList() {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(handle)
  }, [query])

  const searching = debounced.length > 0

  const history = useQuery({
    queryKey: ['threads'],
    queryFn: listThreads,
    enabled: !searching,
  })

  const search = useQuery({
    queryKey: ['thread-search', debounced],
    queryFn: () => searchThreads(debounced),
    enabled: searching,
  })

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameThread(id, title),
    onMutate: async ({ id, title }) => {
      await queryClient.cancelQueries({ queryKey: ['threads'] })
      const previous = queryClient.getQueryData<ThreadsResponse>(['threads'])
      if (previous) {
        queryClient.setQueryData<ThreadsResponse>(['threads'], {
          ...previous,
          sessions: previous.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
        })
      }
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['threads'], context.previous)
      toast.error(`Rename failed: ${describeError(err)}`)
    },
    onSuccess: () => {
      toast.success('Conversation renamed')
      setRenameTarget(null)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteThread(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads'] })
      toast.success('Conversation deleted')
      setDeleteTarget(null)
    },
    onError: (err) => {
      toast.error(`Delete failed: ${describeError(err)}`)
    },
  })

  function openRename(row: { id: string; title: string | null }) {
    setRenameDraft(row.title ?? '')
    setRenameTarget({ id: row.id, title: titleOf(row) })
  }

  function submitRename() {
    if (!renameTarget) return
    const next = renameDraft.trim()
    if (next === '') {
      toast.error('A conversation name cannot be empty')
      return
    }
    rename.mutate({ id: renameTarget.id, title: next })
  }

  const rows = history.data?.sessions ?? []

  return (
    <div className="mt-6">
      <div className="relative">
        <Search
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="pl-9"
        />
      </div>

      {searching ? (
        <SearchResults
          status={search.isPending ? 'loading' : search.isError ? 'error' : 'ready'}
          error={search.isError ? describeError(search.error) : null}
          hits={search.data?.hits ?? []}
          query={debounced}
          onRetry={() => void search.refetch()}
        />
      ) : history.isPending ? (
        <ul className="mt-4 space-y-2" aria-label="Loading conversations">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="rounded-lg border border-border bg-bg-card p-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3 w-24" />
            </li>
          ))}
        </ul>
      ) : history.isError ? (
        <div
          role="alert"
          className="mt-4 flex items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <span>{describeError(history.error)}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void history.refetch()}
            aria-label="Retry loading conversations"
            className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
          >
            <RotateCw size={14} aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-12 text-center">
          <p className="text-sm font-medium text-text-secondary">No conversations yet.</p>
          <p className="mx-auto mt-1 max-w-prose text-sm text-text-muted">
            Conversations you start will appear here.
          </p>
          <Link
            href="/chats/new"
            className="focus-ring mt-5 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg shadow-accent transition-colors hover:bg-accent/90"
          >
            New chat
          </Link>
        </div>
      ) : (
        <ul className="mt-4 space-y-2" aria-label="Conversations">
          {rows.map((row) => {
            const title = titleOf(row)
            return (
              <li
                key={row.id}
                className="group flex items-center gap-2 rounded-lg border border-border bg-bg-card px-4 py-3 transition-colors hover:bg-bg-hover"
              >
                <Link href={`/chats/${row.id}`} className="min-w-0 flex-1 focus-ring rounded">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {title}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    Active {relativeTime(row.updated_at)}
                  </span>
                </Link>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${title}`}
                      className="shrink-0"
                    >
                      <MoreHorizontal size={15} aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => openRename(row)}>
                      <Pencil aria-hidden="true" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleteTarget({ id: row.id, title })}
                    >
                      <Trash2 aria-hidden="true" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              A name you set is pinned — automatic titling will not overwrite it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="conversation-rename">Title</Label>
            <Input
              id="conversation-rename"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitRename()
                }
              }}
              placeholder={UNTITLED}
              aria-label="Conversation title"
              disabled={rename.isPending}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRenameTarget(null)}
              disabled={rename.isPending}
            >
              Cancel
            </Button>
            <Button onClick={submitRename} disabled={rename.isPending}>
              {rename.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete conversation</DialogTitle>
            <DialogDescription>
              Delete “{deleteTarget?.title}”? This removes the conversation and its messages. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              aria-label="Delete conversation"
              onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}
              disabled={remove.isPending}
            >
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface SearchResultsProps {
  status: 'loading' | 'error' | 'ready'
  error: string | null
  hits: { thread_id: string; snippet: string; score: number; created_at: string | null }[]
  query: string
  onRetry: () => void
}

function SearchResults({ status, error, hits, query, onRetry }: SearchResultsProps) {
  if (status === 'loading') {
    return (
      <ul className="mt-4 space-y-2" aria-label="Loading search results">
        {[0, 1, 2].map((i) => (
          <li key={i} className="rounded-lg border border-border bg-bg-card p-4">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </li>
        ))}
      </ul>
    )
  }
  if (status === 'error') {
    return (
      <div
        role="alert"
        className="mt-4 flex items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
      >
        <span>{error}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          aria-label="Retry search"
          className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
        >
          <RotateCw size={14} aria-hidden="true" />
          Retry
        </Button>
      </div>
    )
  }
  if (hits.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
        No conversations match “{query}”.
      </p>
    )
  }
  return (
    <ul className="mt-4 space-y-2" aria-label="Search results">
      {hits.map((hit) => (
        <li
          key={hit.thread_id}
          className="rounded-lg border border-border bg-bg-card px-4 py-3 transition-colors hover:bg-bg-hover"
        >
          <Link href={`/chats/${hit.thread_id}`} className="focus-ring block rounded">
            <span className="block text-sm font-medium text-text-primary">
              Open conversation {hit.thread_id.slice(0, 8)}
            </span>
            <span className="mt-1 block text-sm text-text-secondary">{hit.snippet}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
