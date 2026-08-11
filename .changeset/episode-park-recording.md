---
"@dawn-ai/cli": patch
"@dawn-ai/langchain": patch
---

Stop recording an episodic memory for a turn that parked on a human-in-the-loop
approval. On the non-streaming route path — the one `POST /threads/:id/runs/wait`
uses — the agent adapter discarded the interrupt and returned only the final
state, which never carries `__interrupt__` under `streamEvents`. The recorder
therefore treated the park as a completed run, and the resuming turn recorded a
second episode for the same run: recall saw both a fragment and a duplicate.

The adapter now offers `executeAgentTurn`, which reports the final output and
whether the turn parked, and both route paths tell the recorder which happened.
`executeAgent` is unchanged for existing callers.
