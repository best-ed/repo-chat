import type { IndexedRepo } from './useRepoIndexing'
import type { Citation } from '../utils/citations'

export type { Citation }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /**
   * Every chunk retrieval passed to the model. This is the provenance ceiling,
   * not the display list — what renders is the subset the answer references.
   */
  citations: Citation[]
}

/**
 * Links a citation to the exact revision that was indexed. Using the pinned
 * commit rather than a branch means the lines the answer cites are the lines the
 * answer was actually built from, even after the branch moves on.
 */
export function citationUrl(repo: IndexedRepo, citation: Citation): string | null {
  if (!repo.commitSha) return null
  return `https://github.com/${repo.owner}/${repo.name}/blob/${repo.commitSha}/${citation.path}#L${citation.startLine}-L${citation.endLine}`
}

export function useRepoChat() {
  const messages = useState<ChatMessage[]>('chat-messages', () => [])
  const streaming = useState('chat-streaming', () => false)
  const error = useState<string | null>('chat-error', () => null)

  async function ask(repoId: string, question: string): Promise<void> {
    const trimmed = question.trim()
    if (!trimmed || streaming.value) return

    error.value = null
    messages.value.push({ role: 'user', content: trimmed, citations: [] })
    streaming.value = true

    // Placeholder the stream fills in, so tokens appear as they arrive.
    const answer = reactive<ChatMessage>({ role: 'assistant', content: '', citations: [] })
    messages.value.push(answer)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoId, question: trimmed })
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.statusMessage ?? `Request failed (${response.status}).`)
      }

      // Citations are resolved server-side before generation, so they are known
      // up front and travel in a header rather than being parsed out of prose.
      const header = response.headers.get('x-citations')
      if (header) {
        try {
          answer.citations = JSON.parse(decodeURIComponent(header)) as Citation[]
        } catch {
          answer.citations = []
        }
      }

      const body = response.body
      if (!body) throw new Error('The server returned no answer.')

      const reader = body.pipeThrough(new TextDecoderStream()).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        answer.content += value
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Something went wrong.'
      // Drop the empty placeholder rather than leaving a blank answer on screen.
      const index = messages.value.indexOf(answer)
      if (index !== -1 && !answer.content) messages.value.splice(index, 1)
    } finally {
      streaming.value = false
    }
  }

  function reset(): void {
    messages.value = []
    error.value = null
  }

  return { messages, streaming, error, ask, reset }
}
