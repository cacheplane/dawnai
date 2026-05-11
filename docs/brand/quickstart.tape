# Dawn quickstart demo gif — recorded with VHS.
#
# Rebuild:
#   ./docs/brand/build-gif.sh
#
# (build-gif.sh scaffolds a temp app, starts the stub, runs vhs, cleans up.)
#
# Required env when running this tape directly:
#   DEMO_APP_DIR  — path to a pre-built scaffolded Dawn app.
#   OPENAI_BASE_URL is set below to the local stub.
#
# Output: docs/brand/quickstart.gif

Output docs/brand/quickstart.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1200
Set Height 700
Set TypingSpeed 55ms
Set PlaybackSpeed 1.0

# Point ChatOpenAI at the local fixture-replay stub.
Env OPENAI_BASE_URL "http://127.0.0.1:4317"
Env OPENAI_API_KEY  "sk-demo"
Env PS1 "my-app $ "

Hide
Type "cd /tmp/dawn-demo-app && clear"
Enter
Sleep 500ms
Show

Sleep 800ms

# 1. Peek at the route — the marketing money shot.
Type "cat 'src/app/(public)/hello/[tenant]/index.ts'"
Sleep 400ms
Enter
Sleep 2500ms

# 2. Run it. Real `dawn run`, stubbed LLM.
Type `echo '{"tenant":"acme"}' | pnpm exec dawn run "hello/[tenant]"`
Sleep 400ms
Enter
Sleep 4500ms

Sleep 1500ms
