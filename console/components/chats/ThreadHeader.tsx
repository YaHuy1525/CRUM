'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'

import { describeError, getThread, renameThread } from '@/lib/api'
import { relativeTime } from '@/lib/time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

/**
 * The conversation header row. §"Chats section / Frontend": `/chats/[id]` offers
 * "inline title rename" and the route table calls for a title plus relative last
 * activity.
 *
 * It reads the thread's own metadata through TanStack Query (the same row shape
 * the list uses) so the title and the "active …" line stay honest, and a rename
 * mutates with `source: 'user'` — which the plane pins, so a later auto-title can
 * never overwrite a name the operator chose. The mutation invalidates both this
 * thread and the list, and a toast reports the outcome rather than leaving the
 * operator guessing whether the PATCH landed.
 */
export function ThreadHeader({ threadId }: { threadId: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => getThread(threadId),
  })

  // Seed the dialog input from the live title each time it opens, so a stale draft
  // from a previous rename never lingers.
  useEffect(() => {
    if (open) setDraft(data?.title ?? '')
  }, [open, data])

  const rename = useMutation({
    mutationFn: (title: string) => renameThread(threadId, title),
    onSuccess: (row) => {
      queryClient.setQueryData(['thread', threadId], row)
      void queryClient.invalidateQueries({ queryKey: ['thread', threadId] })
      void queryClient.invalidateQueries({ queryKey: ['threads'] })
      toast.success('Conversation renamed')
      setOpen(false)
    },
    onError: (err) => {
      toast.error(`Rename failed: ${describeError(err)}`)
    },
  })

  const title = data?.title?.trim() ? data.title : 'Untitled conversation'

  function submit() {
    const next = draft.trim()
    if (next === '') {
      toast.error('A conversation name cannot be empty')
      return
    }
    rename.mutate(next)
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate font-display text-xl font-normal tracking-tight text-text-primary">
            {isPending ? 'Loading…' : title}
          </h1>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Rename conversation">
                <Pencil size={15} aria-hidden="true" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rename conversation</DialogTitle>
                <DialogDescription>
                  A name you set is pinned — automatic titling will not overwrite it.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="thread-rename">Title</Label>
                <Input
                  id="thread-rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submit()
                    }
                  }}
                  placeholder="Untitled conversation"
                  aria-label="Conversation title"
                  disabled={rename.isPending}
                />
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={rename.isPending}>
                  Cancel
                </Button>
                <Button onClick={submit} disabled={rename.isPending}>
                  {rename.isPending ? 'Saving…' : 'Save'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <p className="mt-1 text-sm text-text-muted">
          {isError ? (
            <span className="text-danger">{describeError(error)}</span>
          ) : data ? (
            <>Active {relativeTime(data.updated_at)}</>
          ) : (
            'Reading conversation…'
          )}
        </p>
      </div>
      <Link
        href="/chats"
        className="focus-ring inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-bg-card px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover"
      >
        All conversations
      </Link>
    </header>
  )
}
