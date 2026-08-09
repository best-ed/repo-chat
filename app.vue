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
        <div class="flex flex-col gap-2">
          <label for="repo-url" class="text-xs font-medium text-slate-400">
            Repository URL
          </label>
          <input
            id="repo-url"
            type="url"
            placeholder="https://github.com/owner/repo"
            class="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
          >
          <button
            type="button"
            class="rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-white"
          >
            Index repository
          </button>
        </div>

        <div class="flex flex-1 items-center justify-center rounded-md border border-dashed border-slate-800">
          <p class="px-6 text-center text-xs text-slate-600">
            Indexing progress and file stats will appear here.
          </p>
        </div>
      </section>

      <!-- Right: conversation -->
      <section class="flex min-w-0 flex-1 flex-col">
        <div class="flex flex-1 items-center justify-center overflow-y-auto p-5">
          <p class="max-w-sm text-center text-sm text-slate-600">
            Index a repository to start asking questions. Answers cite the file paths
            and line ranges they came from.
          </p>
        </div>

        <div class="shrink-0 border-t border-slate-800 p-5">
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="How does authentication work?"
              class="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
            >
            <button
              type="button"
              class="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
            >
              Send
            </button>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>
