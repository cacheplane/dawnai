import { script } from "../../../packages/testing/dist/index.js";

export const DEMO_PROMPT = "What are common agent architectures?";

export const DEMO_FIXTURES = script()
	.user(DEMO_PROMPT)
	.callsTool("searchCorpus", { query: "agent architectures" })
	.callsTool("readDoc", { path: "corpus/agent-architectures.md" })
	.replies(
		"ReAct and plan-and-execute are common. [corpus/agent-architectures.md]",
	)
	.build();
