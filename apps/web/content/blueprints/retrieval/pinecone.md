---
description: Add a Pinecone-backed retrieval tool to a Dawn app.
website: https://www.pinecone.io
version: 1
tags: [retrieval, vector, embeddings]
source: official
---

# Add Pinecone retrieval to your Dawn app

You are an AI coding agent adding a Pinecone-backed retrieval tool to a Dawn app. It adds a tool the agent can call to query a Pinecone index by semantic similarity. It does NOT create the index, choose an embedding model for you, or ingest documents — it wires the query path against an existing index.

## Prerequisites

Before proceeding, confirm both of the following are true:

1. **Existing Pinecone index** — you have a Pinecone account, an existing index, and the index's dimension matches the embedding model you will use for queries (e.g. `1536` for `text-embedding-3-small`). Note the index name; you will need it.
2. **Embeddings model** — the app already uses an embeddings provider (reuse it), or you will add `@langchain/openai` for OpenAI embeddings.

If either prerequisite is missing, stop and tell the user what needs to be set up before continuing.

## Inspect the project

Run these checks before writing any code:

1. **Package manager** — detect from lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm.
2. **App directory** — read `dawn.config.ts` and find the `appDir` field (defaults to `src/app`). Note which routes exist under it; identify the route that needs retrieval.
3. **AGENTS.md** — read it if present for project-specific conventions (naming, style, preferred imports).
4. **Existing install check** — look for `src/app/<route>/tools/search_documents.ts` (or `src/tools/search_documents.ts` for a shared tool). If the file exists and its first line is `// dawn-blueprint: pinecone@1`, skip to [Updating an existing install](#updating-an-existing-install).
5. **Env conventions** — check for `.env` and `.env.example` to learn how the project names and documents secrets.

## Install dependencies

You need two packages:

- **`@pinecone-database/pinecone`** — the official Pinecone client used to query the index.
- **An embeddings client** — reuse the project's existing LangChain embeddings package if one is already in `package.json` (e.g. `@langchain/openai`, `@langchain/google-genai`). Only add `@langchain/openai` if no embeddings package is present.

Check `package.json` before installing to avoid duplicates. Install only what is missing.

```bash
# pnpm (detected from pnpm-lock.yaml)
pnpm add @pinecone-database/pinecone @langchain/openai

# npm equivalent
# npm install @pinecone-database/pinecone @langchain/openai

# yarn equivalent
# yarn add @pinecone-database/pinecone @langchain/openai
```

## Create the tool

Place the file in the `tools/` directory of the route that needs retrieval. For a shared tool used by multiple routes, use `src/tools/` instead.

```
src/app/<route>/tools/search_documents.ts
```

Write the following file. Read the inline comments — you must adapt the index name, metadata field, and embedding model to match your actual setup before saving.

```ts
// dawn-blueprint: pinecone@1
import { OpenAIEmbeddings } from "@langchain/openai"
import { Pinecone } from "@pinecone-database/pinecone"

// Adapt: replace with the correct embedding model for your index.
// If you are using a different provider, swap OpenAIEmbeddings for its equivalent
// (e.g. GoogleGenerativeAIEmbeddings from @langchain/google-genai).
// The model's output dimension MUST match the dimension of your Pinecone index.
const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small", // must match the dimension used when inserting vectors
})

// PINECONE_API_KEY and PINECONE_INDEX must be set in the environment.
// See Configure environment below.
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! })

// Adapt: if your index name is not stored in PINECONE_INDEX, replace
// process.env.PINECONE_INDEX with the literal index name string.
const index = pc.index(process.env.PINECONE_INDEX!)

/**
 * Search the Pinecone index for vectors semantically similar to the query.
 * Returns the closest matches ranked by similarity score (highest first).
 */
export default async (input: { readonly query: string; readonly limit?: number }) => {
  const topK = input.limit ?? 5

  // Embed the query with the same model used during ingestion.
  const [queryVector] = await embeddings.embedDocuments([input.query])

  const response = await index.query({
    topK,
    vector: queryVector,
    includeMetadata: true,
  })

  // Adapt: replace "text" with the metadata field that holds your document text.
  // Pinecone returns scores in [0, 1] for cosine indexes (1 = identical).
  return {
    results: (response.matches ?? []).map((match) => ({
      text: match.metadata?.text as string,
      score: match.score ?? 0,
    })),
  }
}
```

> **Checklist before saving:**
> - Embedding model matches what was used at ingestion time (dimension must be identical)
> - `PINECONE_INDEX` is set to your index name, or you have replaced `process.env.PINECONE_INDEX` with the literal name
> - The `metadata?.text` field matches the metadata key that holds the chunk text in your index

## Wire it into a route

No manual registration is needed. Dawn discovers every `.ts` file in a route's `tools/` directory automatically. Placing the file there is sufficient — on the next `dawn typegen` run, `search_documents` will appear in `ctx.tools` for that route (fully typed), and an `agent` route's model can call it directly.

Run typegen to refresh the generated declarations:

```bash
dawn typegen
```

After running typegen, `ctx.tools.search_documents` is available inside `workflow` and `graph` entries with full IntelliSense on its input and return shapes.

If this is a shared tool placed in `src/tools/`, it becomes available to every route in the project under the same name.

## Configure environment

Add the following variables to `.env` (never commit this file):

```
# Pinecone credentials — required by search_documents tool
PINECONE_API_KEY=pcsk_...
PINECONE_INDEX=your-index-name

# Required only if using OpenAI embeddings
OPENAI_API_KEY=sk-...
```

Document them in `.env.example` so other contributors know what to set:

```
PINECONE_API_KEY=
PINECONE_INDEX=
OPENAI_API_KEY=
```

If the project uses a different env-loading convention (e.g. a vault, an `env.ts` file, or a platform-injected secret), follow that convention instead of `.env`.

## Verify

1. **Types resolve** — run `dawn typegen` and confirm it exits cleanly. Open `.dawn/dawn.generated.d.ts` and check that `search_documents` appears under the route's tool types.

2. **Dev server starts** — run `dawn dev`. The Pinecone client and index handle are created at module scope; if `PINECONE_API_KEY` or `PINECONE_INDEX` are unset, the first tool call will throw (not startup), so the server should start cleanly even without credentials.

3. **Sample run** — invoke the route with a query that should match vectors in your index:

   ```bash
   echo '{"messages":[{"role":"user","content":"find documents about machine learning"}]}' \
     | dawn run '/your-route'
   ```

   Confirm that the model calls `search_documents`, matches come back with `text` and `score` fields, and scores are between 0 and 1.

4. **No matches** — if `results` is empty, verify that `PINECONE_INDEX` names the correct index, that the embedding model matches what was used at ingestion, and that the metadata field holding the text is named `text` (adapt the `match.metadata?.text` line if not).

## Updating an existing install

If `search_documents.ts` already exists with the `// dawn-blueprint: pinecone@1` marker on its first line:

1. Compare the existing file against the tool template in [Create the tool](#create-the-tool).
2. Apply relevant changes from this guide (e.g. the `includeMetadata: true` flag, the `topK` pattern, the object return shape) while **preserving the user's customisations** — index name, metadata field, embedding model, and any additional query filters they have added.
3. Do not change the marker line; it must remain `// dawn-blueprint: pinecone@1` as the first line of the file.
4. Run `dawn typegen` after updating to confirm types still resolve cleanly.
