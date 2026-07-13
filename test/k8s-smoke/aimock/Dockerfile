# aimock image for the full-arc sandbox smoke.
#
# Serves the committed fixture (test/k8s-smoke/app/fixtures/smoke.json) over an
# OpenAI-compatible /v1/chat/completions endpoint on a FIXED PORT: 4010.
# @copilotkit/aimock has zero runtime dependencies, so this pulls only aimock
# itself from the public npm registry — no Verdaccio needed for this image.
#
# BUILD CONTEXT MUST BE `test/k8s-smoke/` (so both aimock/ and app/fixtures/ are
# reachable), e.g.:
#   docker build -f test/k8s-smoke/aimock/Dockerfile -t dawn-smoke-aimock test/k8s-smoke
FROM node:22-slim
WORKDIR /app

# Pin the exact version the repo resolves for deterministic smoke runs.
RUN npm install --omit=dev @copilotkit/aimock@1.35.1

# Bake the runner + the committed fixture into the image.
COPY aimock/server.mjs ./server.mjs
COPY app/fixtures/smoke.json ./smoke.json

ENV AIMOCK_HOST=0.0.0.0 \
    AIMOCK_PORT=4010 \
    AIMOCK_FIXTURE=/app/smoke.json

EXPOSE 4010
CMD ["node", "server.mjs"]
