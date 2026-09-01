# Dawn product-loop media transcript

The flagship and three derivative clips are silent. Their visible short act
labels — **Author**, **Prove**, and **Run** — are repeated here so the same proof
remains available without motion or audio. The footage begins inside an existing
generated research workspace; it does not show the scaffold command running.

## Product loop (24 seconds)

### Author

The Dawn capture compositor displays real files from the generated research
workspace. Its tree names all five paths used by the story:

- `server/src/app/research/index.ts`
- `server/src/app/research/state.ts`
- `server/src/app/research/plan.md`
- `server/src/tools/searchCorpus.ts`
- `server/test/research.test.ts`

The editor focuses on the `export default agent({` route descriptor and the
shared `searchCorpus` tool. The compositor uses frozen-frame holds to keep the
real captured source legible; the holds do not add product events.

### Prove

The terminal compositor runs the generated workspace's canonical `npm test`
command. The real, narrowly normalized log shows the named deterministic
research scenario passing without a provider key. A frozen-frame hold leaves
the passing result on screen long enough to read.

### Run

The actual generated Dawn Workbench submits “What are common agent
architectures?” to `/research#agent`. Visible tool activity names the
`searchCorpus` and `readDoc` calls. The cited response reads: “ReAct and
plan-and-execute are common. [corpus/agent-architectures.md]”.

The completed run remains visible, then the browser reloads. The same thread is
reopened from the rail, its state request succeeds, and the prompt, both tool
calls, and cited answer reappear from the server checkpoint. This demonstrates
browser-reload restoration with the Dawn server still running, not restoration
after a server restart.

### Close

The closing card reads “TypeScript meta-framework for LangGraph.js”, “Build
LangGraph agents like Next.js apps”, and
`npm create dawn-ai-app@latest my-agent`. The command is an activation next
step; scaffolding is not part of the footage.

## Author clip (9 seconds)

The Author derivative holds the same real generated file tree, route descriptor,
and shared tool on screen for a legible static inspection.

## Test clip (9 seconds)

The Test derivative shows the same real `npm test` result and named offline
research scenario, with a legibility hold after the passing summary.

## Run clip (10 seconds)

The Run derivative begins with the completed Workbench response, follows the
browser reload and same-thread selection, and ends with the restored prompt,
`searchCorpus` and `readDoc` activity, and cited answer.
