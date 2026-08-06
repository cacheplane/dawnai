// Episodic sibling of probe-app: the runtime episode recorder is enabled, so
// every completed run writes one episodic memory (input, outcome, tools used,
// duration) the agent can recall with a time window (`since`/`until`). Exists
// for the gated episodic live smoke.
export default { memory: { writes: "auto", episodes: { enabled: true } } }
