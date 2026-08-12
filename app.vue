<script setup lang="ts">
import type { ChatMessage } from './composables/useRepoChat'

const { url, job, repo, error: indexError, index, isReady, isWorking } = useRepoIndexing()
const { messages, streaming, error: chatError, ask, reset } = useRepoChat()

const question = ref('')

async function onIndex() {
  reset()
  await index()
}

async function onAsk() {
  if (!repo.value) return
  const text = question.value
  question.value = ''
  await ask(repo.value.id, text)
}

/**
 * Sources shown under an answer: the retrieved chunks the answer actually
 * references. Retrieval hands the model more than it uses, and listing all of it
 * would claim provenance the answer does not have.
 */
function sourcesFor(message: ChatMessage) {
  return usedCitations(message.content, message.citations)
}

/** Distinguishes hitting the size cap from any other ingestion failure. */
const isOverLimit = computed(() => /exceeds the/i.test(indexError.value ?? ''))

const progressLabel = computed(() => {
  const state = job.value
  if (!state) return null
  if (state.status === 'READY') return `${state.repo.fileCount} files indexed`
  if (state.total > 0) return `${state.status.toLowerCase()} ${state.progress}/${state.total}`
  return state.status.toLowerCase()
})
</script>

<template>
  <div class="flex h-screen flex-col bg-slate-950 text-slate-200">
    <NuxtRouteAnnouncer />

    <header class="flex shrink-0 items-center gap-3 border-b border-slate-800 px-5 py-3">
      <h1 class="text-sm font-semibold tracking-tight text-slate-100">repo-chat</h1>
      <p class="text-xs text-slate-500">Ask questions about a public GitHub repository</p>
    </header>

    <main class="flex min-h-0 flex-1">
      <!-- Left: repository to index -->
      <section class="flex w-90 shrink-0 flex-col gap-4 border-r border-slate-800 p-5">
        <form class="flex flex-col gap-2" @submit.prevent="onIndex">
          <label for="repo-url" class="text-xs font-medium text-slate-400">
            Repository URL
          </label>
          <input
            id="repo-url"
            v-model="url"
            type="url"
            placeholder="https://github.com/owner/repo"
            class="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
          >
          <button
            type="submit"
            :disabled="isWorking || !url.trim()"
            class="rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {{ isWorking ? 'Indexing…' : 'Index repository' }}
          </button>
          <p class="text-xs leading-relaxed text-slate-600">{{ LIMITS_SUMMARY }}</p>
        </form>

        <div class="flex flex-1 flex-col gap-3 overflow-y-auto rounded-md border border-dashed border-slate-800 p-4">
          <p v-if="!job && !indexError" class="m-auto px-2 text-center text-xs text-slate-600">
            Indexing progress and file stats will appear here.
          </p>

          <template v-if="job">
            <p class="text-xs text-slate-400">{{ progressLabel }}</p>
            <dl v-if="isReady && repo" class="flex flex-col gap-1 text-xs text-slate-500">
              <div class="flex justify-between gap-2">
                <dt>files</dt><dd class="text-slate-300">{{ repo.fileCount }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>bytes</dt><dd class="text-slate-300">{{ repo.byteCount.toLocaleString() }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>commit</dt>
                <dd class="font-mono text-slate-300">{{ repo.commitSha?.slice(0, 7) }}</dd>
              </div>
            </dl>
          </template>

          <div v-if="indexError" class="flex flex-col gap-1 rounded border border-rose-900 bg-rose-950/40 p-3">
            <p class="text-xs font-medium text-rose-300">
              {{ isOverLimit ? 'Repository too large to index' : 'Indexing failed' }}
            </p>
            <p class="text-xs leading-relaxed text-rose-200/80">{{ indexError }}</p>
            <p v-if="isOverLimit" class="text-xs leading-relaxed text-rose-200/60">
              Nothing was indexed — a repository over the cap is rejected outright rather
              than partly indexed, so an answer can never be built from half a codebase.
            </p>
          </div>
        </div>
      </section>

      <!-- Right: conversation -->
      <section class="flex min-w-0 flex-1 flex-col">
        <div class="flex-1 overflow-y-auto p-5">
          <p v-if="messages.length === 0" class="flex h-full items-center justify-center text-center text-sm text-slate-600">
            <span class="max-w-sm">
              Index a repository to start asking questions. Answers cite the file paths
              and line ranges they came from.
            </span>
          </p>

          <ul v-else class="flex flex-col gap-5">
            <li v-for="(message, i) in messages" :key="i" class="flex flex-col gap-2">
              <span class="text-xs font-medium text-slate-500">
                {{ message.role === 'user' ? 'You' : 'repo-chat' }}
              </span>
              <p class="whitespace-pre-wrap text-sm text-slate-200">{{ message.content }}</p>

              <ul v-if="sourcesFor(message).length" class="flex flex-wrap gap-2 pt-1">
                <li v-for="(citation, c) in sourcesFor(message)" :key="c">
                  <a
                    v-if="repo && citationUrl(repo, citation)"
                    :href="citationUrl(repo, citation)!"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  >
                    {{ citation.path }}:{{ citation.startLine }}-{{ citation.endLine }}
                  </a>
                </li>
              </ul>
            </li>
          </ul>
        </div>

        <div class="shrink-0 border-t border-slate-800 p-5">
          <p v-if="chatError" class="pb-2 text-xs text-rose-400">{{ chatError }}</p>
          <form class="flex gap-2" @submit.prevent="onAsk">
            <input
              v-model="question"
              type="text"
              :disabled="!isReady || streaming"
              placeholder="How does authentication work?"
              class="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
            <button
              type="submit"
              :disabled="!isReady || streaming || !question.trim()"
              class="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {{ streaming ? 'Thinking…' : 'Send' }}
            </button>
          </form>
        </div>
      </section>
    </main>
  </div>
</template>
