/**
 * Retrieval distance measurement harness.
 *
 * Calls the app's own retrieval path (server/utils/chat/retrieve.ts) so the
 * numbers are the ones production would see — same embedder, same cosine scan,
 * same SQL. It never touches /api/chat, so it writes no Message rows and spends
 * nothing on generation.
 *
 * Usage:
 *   node --env-file=.env scripts/measure-retrieval.mjs [--out path.json]
 *
 * Repos must already be ingested and READY. Missing ones are reported and
 * skipped rather than failing the run.
 *
 * Each question costs exactly one embedding call: the cosine scan computes a
 * distance for every chunk regardless of LIMIT, so one query with a large limit
 * yields the whole ranked distribution.
 */
import { writeFileSync } from 'node:fs'
import { createJiti } from 'jiti'
import { PrismaClient } from '@prisma/client'

const jiti = createJiti(import.meta.url)
const { retrieveChunks, TOP_K, MAX_DISTANCE } = await jiti.import('../server/utils/chat/retrieve.ts')

const prisma = new PrismaClient()

/** Identical across every repo, so cross-repo comparison is like-for-like. */
const ABSTRACT = [
  'What does this repository do?',
  'Describe the overall architecture of this project.',
  'What are the main components and how do they fit together?'
]

const UNANSWERABLE = [
  'How does this repo handle payment processing and Stripe webhooks?',
  'What is the Kubernetes deployment strategy for the staging cluster?',
  'How are user passwords hashed and stored in the database?'
]

/** `expect` is the path the answer should come from, so ranking is checkable. */
const REPOS = [
  {
    name: 'is-plain-obj',
    shape: 'tiny JS lib, whole-file chunks',
    url: 'https://github.com/sindresorhus/is-plain-obj',
    specific: [
      ['How does this library decide whether a value is a plain object?', 'index.js'],
      ['What happens for an object created with Object.create(null)?', 'index.js'],
      ['How is the TypeScript type predicate declared?', 'index.d.ts']
    ]
  },
  {
    name: 'collab-crdt',
    shape: 'dense TS monorepo, 60-line windows',
    url: 'https://github.com/best-ed/collab-crdt',
    specific: [
      ['How does the client avoid echoing its own DOM updates back as edits?', 'apps/web/pages/index.vue'],
      ['How does Rga.integrate place an element, and how does idCmp order concurrent ids?', 'packages/crdt/src/rga.ts'],
      ['What do getCaretOffset and restoreCaretOffset do?', 'apps/web/pages/index.vue'],
      ['How are concurrent edits merged?', 'packages/crdt/src/rga.ts']
    ]
  },
  {
    name: 'p-queue',
    shape: 'medium TS library, many source + test chunks',
    url: 'https://github.com/sindresorhus/p-queue',
    specific: [
      ['How does PQueue enforce the concurrency limit?', 'source/index.ts'],
      ['When does onIdle resolve?', 'source/index.ts'],
      ['How does PriorityQueue use lowerBound to insert a task?', 'source/priority-queue.ts'],
      ['What do intervalCap and interval control?', 'source/index.ts']
    ]
  },
  {
    name: 'scripts-to-rule-them-all',
    shape: 'tiny docs + config, prose-heavy',
    url: 'https://github.com/github/scripts-to-rule-them-all',
    specific: [
      ['What is script/bootstrap responsible for?', 'README.md'],
      ['What is the difference between script/setup and script/update?', 'README.md'],
      ['What does script/cibuild do?', 'README.md']
    ]
  }
]

const median = (sorted) => sorted.length === 0
  ? Number.NaN
  : sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2

const fmt = (n) => Number.isFinite(n) ? n.toFixed(4) : 'n/a'

async function measure(repo, question, kind, expected) {
  // Large limit: one embedding call yields the full ranked distribution.
  const ranked = await retrieveChunks(repo.id, question, 10_000)
  const distances = ranked.map((c) => c.distance)
  const topK = distances.slice(0, TOP_K)

  return {
    repo: repo.name,
    kind,
    question,
    expected: expected ?? null,
    nearestPath: ranked[0] ? `${ranked[0].path}:${ranked[0].startLine}-${ranked[0].endLine}` : null,
    rankingCorrect: expected ? (ranked[0]?.path === expected) : null,
    nearest: distances[0],
    kth: topK.at(-1),
    // "Does the best hit stand out from the pack?"
    gapToKth: topK.at(-1) - distances[0],
    queryMedian: median(distances),
    // "Is the best hit unusually good for this repo?"
    nearestVsQueryMedian: median(distances) - distances[0],
    max: distances.at(-1),
    passingThreshold: distances.filter((d) => d <= MAX_DISTANCE).length,
    topK
  }
}

const results = []
const skipped = []

for (const spec of REPOS) {
  const row = await prisma.repo.findUnique({
    where: { url: spec.url },
    select: { id: true, job: { select: { status: true } } }
  })

  if (!row || row.job?.status !== 'READY') {
    skipped.push({ name: spec.name, reason: row ? `job is ${row.job?.status}` : 'not ingested' })
    continue
  }

  const repo = { ...spec, id: row.id }
  const chunkCount = await prisma.chunk.count({ where: { repoId: repo.id } })
  console.error(`measuring ${repo.name} (${chunkCount} chunks)…`)

  for (const [question, expected] of spec.specific) {
    results.push({ ...(await measure(repo, question, 'specific', expected)), chunkCount, shape: spec.shape })
  }
  for (const question of ABSTRACT) {
    results.push({ ...(await measure(repo, question, 'abstract')), chunkCount, shape: spec.shape })
  }
  for (const question of UNANSWERABLE) {
    results.push({ ...(await measure(repo, question, 'unanswerable')), chunkCount, shape: spec.shape })
  }

  // Health check: a chunk's own text must retrieve itself at ~0, proving that
  // any distribution differences are semantic rather than mechanical.
  const [sample] = await prisma.chunk.findMany({
    where: { repoId: repo.id }, select: { content: true }, orderBy: { id: 'asc' }, take: 1
  })
  const self = await retrieveChunks(repo.id, sample.content, 1)
  console.error(`  verbatim self-retrieval: ${fmt(self[0]?.distance)}`)
}

// ---------- output ----------

console.log(`\nTOP_K = ${TOP_K}   MAX_DISTANCE = ${MAX_DISTANCE}\n`)
if (skipped.length) {
  console.log('skipped: ' + skipped.map((s) => `${s.name} (${s.reason})`).join(', ') + '\n')
}

console.log('## Per-question measurements\n')
console.log('| repo | kind | question | nearest | k-th | gap | q-median | med−near | pass | rank ok | nearest chunk |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of results) {
  console.log(
    `| ${r.repo} | ${r.kind} | ${r.question.slice(0, 58)} | ${fmt(r.nearest)} | ${fmt(r.kth)} | ` +
    `${fmt(r.gapToKth)} | ${fmt(r.queryMedian)} | ${fmt(r.nearestVsQueryMedian)} | ${r.passingThreshold} | ` +
    `${r.rankingCorrect === null ? '–' : r.rankingCorrect ? 'yes' : 'NO'} | ${r.nearestPath} |`
  )
}

const kinds = ['specific', 'abstract', 'unanswerable']
const stat = (rows, key) => {
  const v = rows.map((r) => r[key]).filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? { min: v[0], median: median(v), max: v.at(-1) } : null
}

console.log('\n## Nearest-distance range by repo and kind\n')
console.log('| repo | chunks | ' + kinds.map((k) => `${k} (min/med/max)`).join(' | ') + ' |')
console.log('|---|---|---|---|---|')
for (const name of [...new Set(results.map((r) => r.repo))]) {
  const cells = kinds.map((k) => {
    const s = stat(results.filter((r) => r.repo === name && r.kind === k), 'nearest')
    return s ? `${fmt(s.min)} / ${fmt(s.median)} / ${fmt(s.max)}` : 'n/a'
  })
  const chunks = results.find((r) => r.repo === name).chunkCount
  console.log(`| ${name} | ${chunks} | ${cells.join(' | ')} |`)
}

console.log('\n## Signal separation (pooled across repos)\n')
console.log('| signal | specific | abstract | unanswerable |')
console.log('|---|---|---|---|')
for (const [label, key] of [
  ['absolute nearest', 'nearest'],
  ['gap nearest→k-th', 'gapToKth'],
  ['query median − nearest', 'nearestVsQueryMedian']
]) {
  const cells = kinds.map((k) => {
    const s = stat(results.filter((r) => r.kind === k), key)
    return s ? `${fmt(s.min)} / ${fmt(s.median)} / ${fmt(s.max)}` : 'n/a'
  })
  console.log(`| ${label} (min/med/max) | ${cells.join(' | ')} |`)
}

// Best single cutpoint per signal, treating specific+abstract as "answerable".
console.log('\n## Best single cutpoint per signal\n')
const answerable = results.filter((r) => r.kind !== 'unanswerable')
const refusable = results.filter((r) => r.kind === 'unanswerable')

console.log('| signal | direction | best cutpoint | misclassified | answerable wrongly refused | unanswerable wrongly admitted |')
console.log('|---|---|---|---|---|---|')
for (const [label, key, admitBelow] of [
  ['absolute nearest', 'nearest', true],
  ['gap nearest→k-th', 'gapToKth', false],
  ['query median − nearest', 'nearestVsQueryMedian', false]
]) {
  const values = results.map((r) => r[key]).filter(Number.isFinite).sort((a, b) => a - b)
  let best = null
  for (let i = 0; i <= values.length; i++) {
    const cut = i === 0 ? values[0] - 0.01 : (values[i - 1] + (values[i] ?? values[i - 1] + 0.01)) / 2
    const wronglyRefused = answerable.filter((r) => admitBelow ? r[key] > cut : r[key] < cut).length
    const wronglyAdmitted = refusable.filter((r) => admitBelow ? r[key] <= cut : r[key] >= cut).length
    const total = wronglyRefused + wronglyAdmitted
    if (!best || total < best.total) best = { cut, total, wronglyRefused, wronglyAdmitted }
  }
  console.log(
    `| ${label} | admit ${admitBelow ? '≤' : '≥'} cut | ${fmt(best.cut)} | ${best.total}/${results.length} | ` +
    `${best.wronglyRefused}/${answerable.length} | ${best.wronglyAdmitted}/${refusable.length} |`
  )
}

const outIndex = process.argv.indexOf('--out')
const outPath = outIndex === -1 ? 'scripts/retrieval-measurements.json' : process.argv[outIndex + 1]
writeFileSync(outPath, JSON.stringify({ topK: TOP_K, maxDistance: MAX_DISTANCE, skipped, results }, null, 2))
console.log(`\nraw data: ${outPath}`)

await prisma.$disconnect()
