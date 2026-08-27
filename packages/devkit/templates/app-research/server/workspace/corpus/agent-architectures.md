# Agent architectures

Most LLM agent systems fall into a few recurring shapes.

- **ReAct**: the model interleaves reasoning traces with tool calls, observing
  each result before deciding the next action. Simple and robust for tool use.
- **Plan-and-execute**: a planner drafts a multi-step plan up front, then an
  executor carries out each step. Better for long tasks where re-planning is
  expensive.
- **Coordinator / subagent**: a coordinator decomposes a task and dispatches
  sub-questions to specialist subagents, then synthesizes their answers. Scales
  to broad research where each branch needs focused context.

Pick the simplest architecture that fits: ReAct for short tool-using tasks,
coordinator/subagent for wide research, plan-and-execute for long procedures.
