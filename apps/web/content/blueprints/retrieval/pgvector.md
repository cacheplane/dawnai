---
description: Add a pgvector-backed retrieval tool to a Dawn app.
website: https://github.com/pgvector/pgvector
version: 1
tags: [retrieval, postgres, vector, embeddings]
source: official
---

# Add pgvector retrieval to your Dawn app

You are an AI coding agent adding a pgvector-backed retrieval tool to a Dawn app. It adds a tool the agent can call to search a Postgres `vector` column by semantic similarity. It does NOT create or migrate the database, choose an embedding model for you, or ingest documents — it wires the search path against an existing table.

## Prerequisites

Before proceeding, confirm both of the following are true:

1. **Existing Postgres database with pgvector** — the `pgvector` extension is enabled (`CREATE EXTENSION IF NOT EXISTS vector;`) and there is a table containing text chunks and an `embedding vector(N)` column (where `N` matches your embedding model's output dimension, e.g. `1536` for `text-embedding-3-small`).
2. **Embeddings model** — the app already uses an embeddings provider (reuse it), or you will add `@langchain/openai` for OpenAI embeddings.

If either prerequisite is missing, stop and tell the user what needs to be set up before continuing.

## Inspect the project

Run these checks before writing any code:

1. **Package manager** — detect from lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm.
2. **App directory** — read `dawn.config.ts` and find the `appDir` field (defaults to `src/app`). Note which routes exist under it; identify the route that needs retrieval.
3. **AGENTS.md** — read it if present for project-specific conventions (naming, style, preferred imports).
4. **Existing install check** — look for `src/app/<route>/tools/search_documents.ts` (or `src/tools/search_documents.ts` for a shared tool). If the file exists and its first line is `// dawn-blueprint: pgvector@1`, skip to [Updating an existing install](#updating-an-existing-install).
5. **Env conventions** — check for `.env` and `.env.example` to learn how the project names and documents secrets.

## Install dependencies

You need two packages:

- **`pg`** — the `node-postgres` client used to query Postgres.
- **An embeddings client** — reuse the project's existing LangChain embeddings package if one is already in `package.json` (e.g. `@langchain/openai`, `@langchain/google-genai`). Only add `@langchain/openai` if no embeddings package is present.

Check `package.json` before installing to avoid duplicates. Install only what is missing.

```bash
# pnpm (detected from pnpm-lock.yaml)
pnpm add pg @langchain/openai

# npm equivalent
# npm install pg @langchain/openai

# yarn equivalent
# yarn add pg @langchain/openai
```

If TypeScript types for `pg` are not already present, add the dev dependency:

```bash
pnpm add -D @types/pg
```

## Create the tool

Place the file in the `tools/` directory of the route that needs retrieval. For a shared tool used by multiple routes, use `src/tools/` instead.

```
src/app/<route>/tools/search_documents.ts
```

Write the following file. Read the inline comments — you must adapt the table name, column names, and embedding dimension to match the real schema before saving.

```ts
// dawn-blueprint: pgvector@1
import { OpenAIEmbeddings } from "@langchain/openai"
import { Pool } from "pg"

// Adapt: replace with the correct embedding model and dimension for your schema.
// If you are using a different provider, swap OpenAIEmbeddings for its equivalent
// (e.g. GoogleGenerativeAIEmbeddings from @langchain/google-genai).
const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small", // must match the dimension used when inserting rows
})

// A single Pool is created once at module scope and reused across calls.
// DATABASE_URL must be set in the environment (see Configure environment below).
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

/**
 * Search the document store for chunks semantically similar to the query.
 * Returns the closest matches ranked by cosine similarity (highest first).
 */
export default async (input: { readonly query: string; readonly limit?: number }) => {
  const limit = input.limit ?? 5

  // Embed the query with the same model used during ingestion.
  const [queryVector] = await embeddings.embedDocuments([input.query])

  // Adapt: replace "documents" with your table name.
  // Adapt: replace "content" with your text column name.
  // Adapt: replace "embedding" with your vector column name.
  // The <=> operator computes cosine distance (0 = identical, 2 = opposite).
  // Casting the JS array to ::vector satisfies pgvector's type requirement.
  const { rows } = await pool.query<{ text: string; distance: number }>(
    `SELECT content AS text,
            embedding <=> $1::vector AS distance
     FROM documents
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [`[${queryVector.join(",")}]`, limit],
  )

  // Convert distance to a similarity score in [0, 1]: score = 1 - distance/2.
  // Cosine distance ∈ [0, 2], so dividing by 2 normalises to [0, 1].
  return {
    results: rows.map((row) => ({
      text: row.text,
      score: 1 - row.distance / 2,
    })),
  }
}
```

> **Schema checklist before saving:**
> - Table name matches your actual table (default: `documents`)
> - Text column name matches (default: `content`)
> - Vector column name matches (default: `embedding`)
> - Embedding model and dimension match what was used at ingestion time

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
# Postgres connection string — required by search_documents tool
DATABASE_URL=postgres://user:password@host:5432/dbname

# Required only if using OpenAI embeddings
OPENAI_API_KEY=sk-...
```

Document them in `.env.example` so other contributors know what to set:

```
DATABASE_URL=
OPENAI_API_KEY=
```

If the project uses a different env-loading convention (e.g. a vault, an `env.ts` file, or a platform-injected secret), follow that convention instead of `.env`.

## Verify

1. **Types resolve** — run `dawn typegen` and confirm it exits cleanly. Open `.dawn/dawn.generated.d.ts` and check that `search_documents` appears under the route's tool types.

2. **Dev server starts** — run `dawn dev`. If `DATABASE_URL` is not set, the `Pool` constructor will throw on first use (not at startup), so the server should start cleanly.

3. **Sample run** — invoke the route with a query that should match documents in your table:

   ```bash
   echo '{"messages":[{"role":"user","content":"find documents about machine learning"}]}' \
     | dawn run '/your-route'
   ```

   Confirm that the model calls `search_documents`, rows come back with `text` and `score` fields, and scores are between 0 and 1.

4. **SQL sanity check** — if no rows come back, verify the table and column names in the query match your actual schema (`\d your_table` in `psql`), and confirm the embedding dimension in the model config matches the vector column dimension.

## Updating an existing install

If `search_documents.ts` already exists with the `// dawn-blueprint: pgvector@1` marker on its first line:

1. Compare the existing file against the tool template in [Create the tool](#create-the-tool).
2. Apply relevant changes from this guide (e.g. the `score` normalisation formula, the Pool pattern, the `::vector` cast) while **preserving the user's customisations** — table name, column names, embedding model, and any additional query filters they have added.
3. Do not change the marker line; it must remain `// dawn-blueprint: pgvector@1` as the first line of the file.
4. Run `dawn typegen` after updating to confirm types still resolve cleanly.
