# syntax=docker/dockerfile:1

# The app image. Node, nothing else: generation and embedding both run in the
# separate ollama service, so there is no model weight and no CUDA runtime in
# here.
#
# node:22-slim, not alpine, and that is deliberate. `unpdf` wraps pdf.js, which
# is the one dependency in this project that is fussy about its JavaScript
# environment, and the host this is usually run on is glibc. Matching it buys
# ~50 MB of image size and removes a whole class of "works on the host, not in
# the container" failures that would otherwise be diagnosed as a PDF bug.
FROM node:22-slim

WORKDIR /app

# Dependencies before source, so an edit to src/ or to the UI does not
# invalidate the install layer. `npm ci` rather than `npm install` because the
# lockfile is committed and `ci` is the only install that will refuse to drift
# from it.
#
# --omit=dev is safe here and worth stating: this project has ZERO
# devDependencies, and the whole test suite runs on node:test plus
# --experimental-test-module-mocks. So the runtime image can drop dev deps
# without losing the ability to run `npm test`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

# The corpus is bind-mounted read-only and the app only ever reads it, so
# nothing here needs to be writable by the app user. Running as non-root is
# free, so it is on.
USER node

# Probes `/`, not `/api/health`. `/api/health` deliberately answers 503 when
# the store is unreachable or nothing has been ingested yet, which is correct
# behaviour and exactly the state a fresh container is in — using it as a
# liveness probe would mark a healthy container unhealthy for the whole of
# first run. `/` is the static UI and means "express is listening".
#
# Written as node rather than curl so the image needs no extra package, and it
# only needs Node >= 18 for the global fetch, which 22 has.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node server.js` directly, not `npm start`. npm would be PID 1's parent and
# would swallow SIGTERM, so `docker compose stop` would have to wait out the
# full 10s grace period every time.
CMD ["node", "server.js"]
