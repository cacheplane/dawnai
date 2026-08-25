# Tool use and function calling

Tools let a model take actions and read external state. Each tool has a name, a
typed input schema, and a return value the model reads back.

- Give tools narrow, well-described inputs — the schema is the contract the
  model plans against.
- Return structured, concise results; large outputs should be summarized or
  offloaded so they do not crowd the context window.
- Validate tool inputs and fail with a clear message; a good error lets the
  model recover instead of looping.
