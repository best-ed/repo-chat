const POLL_INTERVAL_MS = 1000

export interface IndexedRepo {
  id: string
  url: string
  owner: string
  name: string
  commitSha: string | null
  fileCount: number
  byteCount: number
}

interface JobState {
  jobId: string
  status: string
  stage: string
  error: string | null
  progress: number
  total: number
  repo: IndexedRepo
}

/** Submits a repository for indexing and follows the job to a terminal state. */
export function useRepoIndexing() {
  const url = useState('repo-url', () => '')
  const job = useState<JobState | null>('repo-job', () => null)
  const error = useState<string | null>('repo-error', () => null)
  const submitting = useState('repo-submitting', () => false)

  const repo = computed(() => job.value?.repo ?? null)
  const isReady = computed(() => job.value?.status === 'READY')
  const isFailed = computed(() => job.value?.status === 'FAILED')
  const isWorking = computed(() =>
    submitting.value || (job.value !== null && !isReady.value && !isFailed.value)
  )

  let timer: ReturnType<typeof setTimeout> | null = null

  const stopPolling = () => {
    if (timer) { clearTimeout(timer) ; timer = null }
  }

  async function poll(jobId: string): Promise<void> {
    try {
      const state = await $fetch<JobState>(`/api/jobs/${jobId}`)
      job.value = state

      if (state.status === 'READY' || state.status === 'FAILED') {
        stopPolling()
        if (state.status === 'FAILED') error.value = state.error
        return
      }
    } catch (err) {
      stopPolling()
      error.value = err instanceof Error ? err.message : 'Lost track of the indexing job.'
      return
    }

    timer = setTimeout(() => { void poll(jobId) }, POLL_INTERVAL_MS)
  }

  async function index(): Promise<void> {
    const target = url.value.trim()
    if (!target || submitting.value) return

    stopPolling()
    error.value = null
    job.value = null
    submitting.value = true

    try {
      const { jobId } = await $fetch<{ jobId: string }>('/api/repos', {
        method: 'POST',
        body: { url: target }
      })
      await poll(jobId)
    } catch (err) {
      error.value = extractMessage(err, 'Could not start indexing.')
    } finally {
      submitting.value = false
    }
  }

  onScopeDispose(stopPolling)

  return { url, job, repo, error, index, isReady, isFailed, isWorking }
}

/** h3 puts the useful text on statusMessage; the default message is generic. */
function extractMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: { statusMessage?: string } })?.data
  return data?.statusMessage ?? (err instanceof Error ? err.message : fallback)
}
