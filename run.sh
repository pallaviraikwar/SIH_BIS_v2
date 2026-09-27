#!/usr/bin/env bash
#
# One-command setup and launch for the BIS RAG assistant.
#
#   ./run.sh              preflight, build, start, wait, ingest if empty, verify
#   ./run.sh --status     what is running. Changes nothing.
#   ./run.sh --stop       stop the stack, keep the data
#   ./run.sh --reset      stop it and delete the database and the model weights
#   ./run.sh --help       everything else
#
# Why this exists: `docker compose up -d` returns as soon as the containers are
# *created*, not when they are usable. Postgres is still running initdb, Ollama is
# still loading, and the model pull is still 400 MB from done. It exits 0 the whole
# time, so the usual "up -d && curl" is a race that fails on a cold machine and
# works on a warm one, which is the worst kind of bug to hand someone. This waits
# for each service to report a real state before moving on.
#
# Linux, macOS and WSL only. See "On Windows" in README.md.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$SCRIPT_DIR"

# ---------------------------------------------------------------- presentation

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

step() { printf '\n%s%s>%s %s%s%s\n' "$C_BLUE" "$C_BOLD" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '  %s\n' "$*"; }
dim()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s! %s%s\n' "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '\n%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- constants
#
# These must match the container_name values in docker-compose.yml. The wait loop
# polls them with `docker inspect` rather than `docker compose ps --format json`,
# whose output shape has changed across Compose versions and would silently break.

C_PGVECTOR=bis-pgvector
C_OLLAMA=bis-ollama
C_MODELS=bis-ollama-models
C_APP=bis-app

# docker-compose.yml line ~141 uses `env_file: required: false`, which does not
# exist before Compose 2.24.0. Checking for "v2" would pass the preflight and then
# fail on the real command with a parse error that blames the compose file.
MIN_COMPOSE_MAJOR=2
MIN_COMPOSE_MINOR=24

WAIT_TIMEOUT=1800
POLL_SECONDS=3
HEALTH_TIMEOUT=15

# ---------------------------------------------------------------- flags

ACTION=up
FORCE_INGEST=0
SKIP_INGEST=0
SMOKE=0

usage() {
  cat <<'EOF'
Usage: ./run.sh [options]

  (no options)      preflight, build, start, wait for ready, ingest if the
                    corpus is empty, then print the health report
  --status          print what is running and the health report; change nothing
  --logs            follow the app and ollama logs (Ctrl-C to stop)
  --stop            stop the stack, keep the database and models
  --reset           stop it and DELETE the database and the model weights
  --smoke           also ask one real question end to end, and show the answer
  --force-ingest    re-embed even though the corpus already has chunks
  --skip-ingest     bring the stack up and stop there
  --timeout N       seconds to wait for services to become ready (default 1800)
  -h, --help        this text

Linux, macOS and WSL. On Windows, run this from PowerShell as:
  wsl -d Ubuntu -- bash -lc "cd <wsl-path>/SIH_BIS_v2 && ./run.sh"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status)      ACTION=status ;;
    --logs)        ACTION=logs ;;
    --stop)        ACTION=stop ;;
    --reset)       ACTION=reset ;;
    --help|-h)     usage; exit 0 ;;
    --smoke)       SMOKE=1 ;;
    --force-ingest) FORCE_INGEST=1 ;;
    --skip-ingest) SKIP_INGEST=1 ;;
    --timeout)
      [[ $# -ge 2 ]] || die "--timeout needs a number"
      WAIT_TIMEOUT="$2"; shift
      ;;
    --timeout=*)   WAIT_TIMEOUT="${1#*=}" ;;
    *)             die "unknown option: $1  (try --help)" ;;
  esac
  shift
done

[[ "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout must be a number, got: $WAIT_TIMEOUT"

# ---------------------------------------------------------------- shell guard

# Git Bash on Windows is installed on some machines, and it will run this entire
# script and then fail every docker call, because the daemon it needs is the one
# inside WSL. Fail on the first line instead of 40 lines later.
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    die "this is Git Bash, which has no route to the WSL Docker daemon.
       From PowerShell run:
         wsl -d Ubuntu -- bash -lc \"cd <wsl-path>/SIH_BIS_v2 && ./run.sh\"
       or use the plain 'docker compose up -d --build' commands in README.md."
    ;;
esac

for tool in curl grep sed awk; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

# ---------------------------------------------------------------- docker

# Resolved once. Everything downstream goes through "${DC[@]}", so a sudo password
# is asked for a single time rather than thirty.
DC=()

resolve_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    die "Docker is not installed. Install Docker Engine (Linux) or Docker Desktop
       (macOS/Windows), then re-run. See README.md Prerequisites."
  fi

  if docker ps >/dev/null 2>&1; then
    DC=(docker)
    return 0
  fi

  warn "docker is not usable as $(id -un) without elevation."
  if ! command -v sudo >/dev/null 2>&1; then
    die "add your user to the docker group:
       sudo usermod -aG docker \$USER && newgrp docker
       then log out and back in, and confirm 'docker ps' works."
  fi
  if [[ ! -t 0 ]]; then
    die "no terminal attached, so the sudo password cannot be asked for.
       Run this from an interactive terminal, or fix group membership once:
       sudo usermod -aG docker \$USER && newgrp docker"
  fi
  info "asking for your password once, then reusing it (sudo -v)"
  sudo -v || die "sudo failed."
  DC=(sudo docker)
  docker ps >/dev/null 2>&1 || sudo docker ps >/dev/null 2>&1 \
    || die "still cannot talk to the Docker daemon as root. Check 'systemctl status docker'."
}

# Accepts "docker compose" (v2+) or the standalone "docker-compose" (v2+ only —
# the python v1 is rejected, it does not understand this compose file at all).
resolve_compose() {
  local ver major minor rest
  if docker compose version --short >/dev/null 2>&1; then
    DC+=(--compose-version-check)
  fi
  if "${DC[@]}" compose version --short >/dev/null 2>&1; then
    ver="$("${DC[@]}" compose version --short 2>/dev/null | tr -d '[:space:]')"
    check_compose_version "$ver" "docker compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1 \
     && ver="$(docker-compose version --short 2>/dev/null | tr -d '[:space:]')" \
     && [[ "$ver" == 2.* ]]; then
    DC=(docker-compose)
    check_compose_version "$ver" "docker-compose"
    return 0
  fi
  die "no working Docker Compose found.
       Need Compose v${MIN_COMPOSE_MAJOR}.${MIN_COMPOSE_MINOR}.0 or later, because
       docker-compose.yml uses 'env_file: required: false', added in 2.24.0."
}

check_compose_version() {
  local ver="$1" name="$2" major minor rest
  ver="${ver#v}"
  [[ "$ver" =~ ^([0-9]+)\.([0-9]+) ]] || die "could not parse the $name version: '$ver'"
  major="${BASH_REMATCH[1]}"
  rest="${ver#*.}"
  minor="${rest%%.*}"
  if (( major < MIN_COMPOSE_MAJOR )); then
    die "$name is v$major. Need v${MIN_COMPOSE_MAJOR}.${MIN_COMPOSE_MINOR}.0 or later."
  fi
  if (( major == MIN_COMPOSE_MAJOR && minor < MIN_COMPOSE_MINOR )); then
    die "$name is v${major}.${minor}. Need v${MIN_COMPOSE_MAJOR}.${MIN_COMPOSE_MINOR}.0 or later —
       docker-compose.yml uses 'env_file: required: false', which was added in 2.24.0.
       Upgrade with: docker compose self-update"
  fi
  ok "$name v$ver (needs >= v${MIN_COMPOSE_MAJOR}.${MIN_COMPOSE_MINOR}.0)"
}

compose() { "${DC[@]}" compose "$@"; }

# ---------------------------------------------------------------- helpers

# Is something already listening on this host port? Tried because `ss` is
# iproute2-only and `lsof` is not installed everywhere.
port_busy() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q .; then return 0; fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then return 0; fi
  fi
  return 1
}

# Health status if the container has a healthcheck, else its run state. The
# healthcheck for bis-app comes from the Dockerfile, not from compose.
container_state() {
  "${DC[@]}" inspect -f \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$1" 2>/dev/null || echo "missing"
}

container_exit_code() {
  "${DC[@]}" inspect -f '{{.State.ExitCode}}' "$1" 2>/dev/null || echo "-"
}

# Wait for a container to report `healthy`. Prints only when the state changes, so
# a three-minute model pull is one line instead of sixty.
wait_healthy() {
  local name="$1" label="$2" deadline=$((SECONDS + WAIT_TIMEOUT)) last="" state
  while :; do
    state="$(container_state "$name")"
    if [[ "$state" != "$last" ]]; then
      printf '  %-18s %s\n' "$label" "$state"
      last="$state"
    fi
    case "$state" in
      healthy)   return 0 ;;
      unhealthy) return 1 ;;
      exited|dead)
        printf '  %-18s %s (exit %s)\n' "$label" "$state" "$(container_exit_code "$name")"
        return 1
        ;;
    esac
    if (( SECONDS >= deadline )); then
      printf '  %-18s still %s after %ss\n' "$label" "$state" "$WAIT_TIMEOUT"
      return 2
    fi
    sleep "$POLL_SECONDS"
  done
}

# The models container is one-shot by design: it pulls three models and exits 0.
wait_completed() {
  local name="$1" label="$2" deadline=$((SECONDS + WAIT_TIMEOUT)) last="" state ec
  while :; do
    state="$(container_state "$name")"
    ec="$(container_exit_code "$name")"
    if [[ "$state" != "$last" ]]; then
      printf '  %-18s %s (exit %s)\n' "$label" "$state" "$ec"
      last="$state"
    fi
    if [[ "$state" == "exited" || "$state" == "completed" ]]; then
      if [[ "$ec" == "0" ]]; then return 0; else return 1; fi
    fi
    if [[ "$state" == "missing" ]]; then
      if (( SECONDS >= deadline )); then return 2; fi
    elif (( SECONDS >= deadline )); then
      printf '  %-18s still %s after %ss\n' "$label" "$state" "$WAIT_TIMEOUT"
      return 2
    fi
    sleep "$POLL_SECONDS"
  done
}

show_logs() {
  local service="$1" lines="${2:-30}"
  printf '  %slast %s lines of %s:%s\n' "$C_DIM" "$lines" "$service" "$C_RESET"
  compose logs --no-color --tail "$lines" "$service" 2>&1 | sed 's/^/    /' || true
}

# The published host port, read back from compose rather than assumed, so this
# keeps working if someone makes it configurable.
app_base_url() {
  local port
  port="$(compose port app 3000 2>/dev/null | head -1)"
  port="${port##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || port=3000
  printf 'http://localhost:%s' "$port"
}

# /api/health answers 503 when the corpus is empty, which is a correct response
# and not a failure — so curl must NOT use -f here, or the body explaining why
# gets thrown away. chunkCount is the first key in the corpus object
# (src/routes/health.js), so the first match is the total and not a per-document
# count from the documents array.
health_json() {
  curl -s -m "$HEALTH_TIMEOUT" "$(app_base_url)/api/health" 2>/dev/null || true
}

health_field() {
  local key="$1" json="$2"
  printf '%s' "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*[^,}]*" | head -1 \
    | sed 's/.*:[[:space:]]*//' | tr -d '"' || true
}

on_error() {
  local code=$?
  printf '\n%sfailed%s (exit %s) at run.sh line %s\n' "$C_RED" "$C_RESET" "$code" "$1" >&2
  if [[ ${#DC[@]} -gt 0 ]]; then
    printf '  the stack was left running on purpose, so you can inspect it:\n' >&2
    printf '    docker compose ps\n    docker compose logs app\n' >&2
  fi
  exit "$code"
}
trap 'on_error "$LINENO"' ERR

# ---------------------------------------------------------------- preflight

preflight() {
  step "Checking the environment"
  resolve_docker
  resolve_compose

  shopt -s nullglob
  local pdfs=(data/pdfs/*.pdf data/pdfs/*.PDF)
  shopt -u nullglob
  if (( ${#pdfs[@]} == 0 )); then
    warn "no PDFs in data/pdfs — the corpus is gitignored, so a fresh clone is empty."
    dim "The app will start and answer everything with 'not found' until you add some."
    dim "Copy your BIS PDFs into data/pdfs/ and re-run, or pass --skip-ingest to continue now."
  else
    ok "${#pdfs[@]} PDF(s) in data/pdfs"
  fi

  if port_busy 3000; then
    warn "port 3000 is already in use. If that is a previous copy of this app,"
    dim "stop it first (./run.sh --stop) or the container will not be able to bind."
  fi

  if port_busy 5433; then
    # This is true on the machine this was written on, and it is the single most
    # likely reason `docker compose up` fails on first contact.
    warn "port 5433 is already in use, so the database container will not start."
    dim "Check what is there:  ss -ltnp | grep 5433"
    dim "Either stop it, or move this stack's port:  PG_HOST_PORT=5434 ./run.sh"
    dim "Only the host side moves; the app reaches the database at pgvector:5432 regardless."
  fi
}

ensure_env() {
  step "Configuration"
  if [[ -f .env ]]; then
    ok ".env exists (left untouched)"
  elif [[ -f .env.example ]]; then
    cp .env.example .env
    ok "created .env from .env.example — every default is local, there is no key to add"
  else
    die "no .env and no .env.example. Cannot continue."
  fi
}

# ---------------------------------------------------------------- actions

do_status() {
  step "Status"
  resolve_docker
  resolve_compose
  compose ps || true
  local json status chunks docs
  json="$(health_json)"
  if [[ -z "$json" ]]; then
    warn "the app is not answering on $(app_base_url) — is the stack up?"
    return 1
  fi
  status="$(health_field status "$json")"
  chunks="$(health_field chunkCount "$json")"
  docs="$(health_field docCount "$json")"
  printf '\n  status      %s\n' "${status:-unknown}"
  printf '  documents   %s\n' "${docs:-0}"
  printf '  chunks      %s\n' "${chunks:-0}"
  if [[ "$status" != "ok" ]]; then
    printf '\n  %swarnings:%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s' "$json" | sed 's/.*"warnings"[[:space:]]*:[[:space:]]*\[//; s/\].*//; s/","/\n  - /g; s/"//g'
  fi
}

do_stop() {
  step "Stopping"
  resolve_docker
  resolve_compose
  compose down
  ok "stopped. The database and the model weights are still there."
}

do_reset() {
  step "Resetting"
  resolve_docker
  resolve_compose
  printf '  This deletes the database volume and ~3 GB of model weights.\n' >&2
  local answer
  read -r -p "  Type 'reset' to continue: " answer
  if [[ "$answer" != "reset" ]]; then
    info "cancelled. Nothing was deleted."
    return 0
  fi
  compose down -v
  ok "deleted. Next ./run.sh starts from an empty corpus."
}

do_logs() {
  resolve_docker
  resolve_compose
  compose logs -f app ollama
}

do_up() {
  preflight
  ensure_env

  step "Building and starting the stack"
  info "first run pulls ~3 GB of models; later runs take seconds"
  compose up -d --build

  step "Waiting for each service to be actually ready"
  # Order mirrors depends_on, so the output reads as a narrative.
  if ! wait_healthy "$C_PGVECTOR" "postgres"; then
    warn "postgres never became healthy. Its logs:"
    show_logs pgvector 40
    die "the database did not come up. Nothing else can work until it does."
  fi

  if ! wait_healthy "$C_OLLAMA" "ollama"; then
    warn "ollama never became healthy. Its logs:"
    show_logs ollama 40
    die "the model server did not come up."
  fi

  if ! wait_completed "$C_MODELS" "models"; then
    warn "the model pull did not finish successfully. Its logs:"
    show_logs models 40
    die "models missing. The app is deliberately held down until they arrive,
       rather than starting and answering every question with a model error."
  fi

  if ! wait_healthy "$C_APP" "app"; then
    warn "the app never became healthy. Its logs:"
    show_logs app 40
    die "the app did not come up."
  fi

  maybe_ingest
  report
}

# ---------------------------------------------------------------- ingest

chunk_count() {
  local json="$1"
  [[ -n "$json" ]] || { printf '0'; return 0; }
  local n
  n="$(printf '%s' "$json" | grep -o '"chunkCount"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 \
       | grep -o '[0-9]*' || true)"
  printf '%s' "${n:-0}"
}

maybe_ingest() {
  if (( SKIP_INGEST )); then
    step "Ingest"
    dim "skipped (--skip-ingest)"
    return 0
  fi

  step "Ingest"
  local json chunks
  json="$(health_json)"
  chunks="$(chunk_count "$json")"

  if [[ "$chunks" =~ ^[0-9]+$ ]] && (( chunks > 0 )) && (( FORCE_INGEST == 0 )); then
    ok "corpus already has $chunks chunk(s) — skipping (--force-ingest to re-embed)"
    return 0
  fi

  if (( FORCE_INGEST )); then
    info "--force-ingest: re-embedding everything"
  fi

  info "extracting, chunking and embedding. This runs locally on CPU and can take"
  info "5-20 minutes for a few thousand chunks. Output streams below — it is not stuck."
  local started=$SECONDS
  # --no-deps so Compose does not re-run the finished models container as a
  # dependency of this one-off container.
  compose run --rm --no-deps app npm run ingest
  ok "ingest finished in $(( (SECONDS - started) / 60 ))m $(( (SECONDS - started) % 60 ))s"
}

# ---------------------------------------------------------------- report

report() {
  step "Health"
  local json status chunks docs
  json="$(health_json)"
  if [[ -z "$json" ]]; then
    warn "the app is not answering on $(app_base_url)."
    return 1
  fi

  status="$(health_field status "$json")"
  chunks="$(health_field chunkCount "$json")"
  docs="$(health_field docCount "$json")"

  printf '  %-12s %s\n' "status"    "${status:-unknown}"
  printf '  %-12s %s\n' "documents" "${docs:-0}"
  printf '  %-12s %s\n' "chunks"    "${chunks:-0}"

  if [[ "$status" == "ok" ]]; then
    ok "ready"
  else
    warn "status is '${status:-unknown}'. The endpoint says why:"
    printf '%s' "$json" | sed 's/.*"warnings"[[:space:]]*:[[:space:]]*\[//; s/\].*//; s/","/\n    - /g; s/"//g' >&2
  fi

  if (( SMOKE )); then
    smoke_test
  fi

  step "Done"
  printf '  %sOpen:%s %s\n' "$C_BOLD" "$C_RESET" "$(app_base_url)"
  info "try:  curl -s $(app_base_url)/api/chat -H 'content-type: application/json' \\"
  info "        -d '{\"query\":\"maximum moisture permitted in clay bricks\",\"lang\":\"auto\"}'"
  info "logs: ./run.sh --logs      stop: ./run.sh --stop      status: ./run.sh --status"
}

# One real question, so "it started" is not mistaken for "it works". Generation on
# CPU is tens of seconds, hence the generous timeout.
smoke_test() {
  step "Smoke test"
  local base answer
  base="$(app_base_url)"
  info "asking one question end to end — generation on CPU takes a while"
  answer="$(curl -s -m 300 "$base/api/chat" -H 'content-type: application/json' \
    -d '{"query":"maximum moisture permitted in clay bricks","lang":"auto"}' || true)"
  if [[ -z "$answer" ]]; then
    warn "no response from /api/chat within 300s. Check ./run.sh --logs."
    return 1
  fi
  local sources
  sources="$(printf '%s' "$answer" | grep -o '"docTitle"' | grep -c . || true)"
  printf '\n'
  printf '%s' "$answer" \
    | sed 's/.*"answer"[[:space:]]*:[[:space:]]*"//; s/"[[:space:]]*,[[:space:]]*"sources".*//' \
    | sed 's/<[^>]*>//g; s/\\n/\n/g; s/\\"/"/g' \
    | fold -s -w 78 | sed 's/^/  /'
  printf '\n'
  if [[ "${sources:-0}" -gt 0 ]]; then
    ok "grounded answer with $sources source(s) cited"
  else
    warn "no sources cited. Either the corpus is empty, or the question is not in it."
  fi
}

# ---------------------------------------------------------------- main

case "$ACTION" in
  up)      do_up ;;
  status)  do_status ;;
  logs)    do_logs ;;
  stop)    do_stop ;;
  reset)   do_reset ;;
esac
