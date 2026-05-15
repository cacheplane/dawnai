# Chat — web smoke client

This client exists to prove the server pipe end-to-end. It is **not** the production UI.

Expect this directory to be replaced once Dawn's harness primitives stabilize (subagents,
planning state, skills, sandbox backends). Until then: textarea, Send button, raw SSE event log.

If you want a richer view of what the agent is doing, `ls`, `tail -F`, or `watch` the
`examples/chat/server/workspace/` directory in another terminal.
