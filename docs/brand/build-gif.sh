#!/usr/bin/env bash
# Build docs/brand/quickstart.gif end to end:
#   1. Scaffold a temp Dawn app from the local create-dawn-app build.
#   2. Start the OpenAI stub on 127.0.0.1:4317 with the captured fixture.
#   3. Run vhs against quickstart.tape.
#   4. Clean up.
#
# Requirements: pnpm, node, vhs (`brew install vhs`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE="$SCRIPT_DIR/quickstart-fixture.json"
TAPE="$SCRIPT_DIR/quickstart.tape"

if [[ ! -f "$FIXTURE" ]]; then
  echo "error: fixture not found at $FIXTURE" >&2
  echo "Run: node docs/brand/capture-fixture.mjs" >&2
  exit 1
fi

if ! command -v vhs >/dev/null 2>&1; then
  echo "error: vhs not installed (try: brew install vhs)" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d -t dawn-demo-build.XXXXXX)"
APP_DIR="$TMP_ROOT/my-app"
# The .tape file hardcodes /tmp/dawn-demo-app (VHS doesn't expand env vars in
# Type strings). Symlink the freshly scaffolded app to that fixed path.
SYMLINK="/tmp/dawn-demo-app"
STUB_PID=""

cleanup() {
  if [[ -n "$STUB_PID" ]]; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
  if [[ -L "$SYMLINK" ]]; then
    rm -f "$SYMLINK"
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

echo "[build-gif] scaffolding into $APP_DIR"
if [[ ! -x "$REPO_ROOT/packages/create-dawn-app/dist/bin.js" ]]; then
  ( cd "$REPO_ROOT" && pnpm build )
fi
node "$REPO_ROOT/packages/create-dawn-app/dist/bin.js" "$APP_DIR" \
  --template basic --mode internal

echo "[build-gif] installing app deps"
( cd "$APP_DIR" && pnpm install --silent )

# Symlink to the fixed path that the .tape references.
if [[ -L "$SYMLINK" || -e "$SYMLINK" ]]; then
  rm -rf "$SYMLINK"
fi
ln -s "$APP_DIR" "$SYMLINK"

echo "[build-gif] starting stub on 127.0.0.1:4317"
node "$SCRIPT_DIR/stub-openai.mjs" --fixture "$FIXTURE" --port 4317 &
STUB_PID=$!
# Give the stub a moment to bind.
sleep 0.5

echo "[build-gif] running vhs"
vhs "$TAPE"

echo "[build-gif] wrote $SCRIPT_DIR/quickstart.gif"
ls -lh "$SCRIPT_DIR/quickstart.gif"
