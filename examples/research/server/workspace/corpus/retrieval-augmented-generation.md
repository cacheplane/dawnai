# Retrieval-augmented generation (RAG)

RAG grounds a model's answer in retrieved source documents instead of relying
only on parametric memory. A typical pipeline: chunk the corpus, embed the
chunks, retrieve the top matches for a query, and pass them to the model as
context with an instruction to cite them.

- Retrieval quality dominates answer quality — bad retrieval cannot be fixed by
  a better prompt.
- Keep chunks small enough to be specific but large enough to be self-contained.
- Always ask the model to cite the chunk it used so claims are auditable.
