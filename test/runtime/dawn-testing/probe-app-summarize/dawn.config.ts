export default {
  summarization: {
    enabled: true,
    maxTokens: 10,
    keepRecentTurns: 1,
    tokenCounter: (text: string) => text.length,
    summarize: async () => "DETERMINISTIC_SUMMARY_OF_OLD_TURNS",
  },
}
