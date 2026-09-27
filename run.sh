#!/usr/bin/env bash
#
# One-command setup and launch for the BIS RAG assistant.
#
#   ./run.sh              preflight, build, start, wait, load the corpus, verify
#   ./run.sh --status     what is running. Changes nothing.
#   ./run.sh --stop       stop the stack, keep the data
#   ./run.sh --reset      stop it and delete the database volume
#   ./run.sh --help       everything else
#
# Why this exists: `docker compose up -d` returns as soon as the containers are
# *created*, not when they are usable. Postgres is still running initdb and the app
# is still migrating. It exits 0 the whole time, so the usual "up -d && curl" is a
# race that fails on a cold machine and works on a warm one, which is the worst
# kind of bug to hand someone. This waits for each service to report a real state
# before moving on.
#
# Ollama runs on the host, not in a container, and that is deliberate. Model weights
# are 4.6 GB; keeping them in a named volume that Compose can prune means losing
# them to a stray `docker compose down -v`, and it means every new machine
# re-downloads models it may already have. The host already has them, so the
# container reaches out to the host instead.
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
C_APP=bis-app

# Where the host's Ollama listens, and the address the container uses to reach it.
# These must match docker-compose.yml. host.docker.internal maps to the host
# gateway via extra_hosts, which is why a loopback-bound Ollama still cannot be
# reached and has to be rebound to 0.0.0.0 (scripts/ollama-host-setup.sh).
OLLAMA_HOST_PORT=11434
OLLAMA_CONTAINER_URL="http://host.docker.internal:${OLLAMA_HOST_PORT}"
OLLAMA_LOCAL_URL="http://127.0.0.1:${OLLAMA_HOST_PORT}"
OLLAMA_SETUP_SCRIPT="scripts/ollama-host-setup.sh"

# Must match the filenames in src/snapshot.js.
LATEST_FILE=LATEST
MANIFEST_FILE=manifest.json

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
# Snapshot handling. Default is: use a snapshot if there is a compatible one and
# the corpus is empty. SNAPSHOT_MODE is 'auto', 'never' or 'only'.
SNAPSHOT_MODE=auto

usage() {
  cat <<'EOF'
Usage: ./run.sh [options]

  (no options)      preflight, build, start, wait for ready, load the corpus,
                    then print the health report
  --status          print what is running and the health report; change nothing
  --logs            follow the app logs (Ctrl-C to stop)
  --stop            stop the stack, keep the database
  --reset           stop it and DELETE the database volume
  --smoke           also ask one real question end to end, and show the answer
  --force-ingest    re-embed even though the corpus already has chunks
  --skip-ingest     bring the stack up and stop there
  --import-snapshot only load a prepared index; never fall back to ingest
  --no-snapshot     ignore index-snapshots/ and ingest from the PDFs
  --timeout N       seconds to wait for services to become ready (default 1800)
  -h, --help        this text

Loading the corpus
  An empty store is filled from index-snapshots/ if a compatible bundle is there,
  which takes seconds, and from the PDFs in data/pdfs/ otherwise, which takes
  minutes. The import refuses a bundle whose embedding model does not match
  .env, then falls back to ingest, so an incompatible bundle is a slower start
  rather than a failed one.

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
    --import-snapshot) SNAPSHOT_MODE=only ;;
    --no-snapshot) SNAPSHOT_MODE=never ;;
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
  # Note: do not append any global flag to DC here. DC may be `sudo docker`, and
  # a stray flag makes every later "docker ..." call fail, which then gets
  # reported as "no working Docker Compose found" and blamed on the compose file.
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

# Is the host's Ollama answering, and can a container reach it?
#
# These are two different questions and both matter. The first is whether the model
# server exists; the second is whether it is bound somewhere a container can see.
# A loopback-only Ollama answers the first and fails the second, which is the whole
# reason scripts/ollama-host-setup.sh exists.
ollama_local_ready() {
  curl -s -m 5 "${OLLAMA_LOCAL_URL}/api/tags" 2>/dev/null | grep -q '"name"' || return 1
}

ollama_reachable_from_container() {
  local out
  # Runs inside a container, so this is the only test that reflects what the app
  # will actually experience.
  out="$(compose run --rm --no-deps -T app node -e "
    fetch(process.env.OLLAMA_BASE_URL + '/api/tags')
      .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(t => { process.stdout.write(t.includes('models') ? 'ok' : 'empty'); })
      .catch(() => process.stdout.write('fail'));
  " 2>/dev/null | tr -d '[:space:]' || true)"
  case "$out" in
    ok|empty) return 0 ;;
    *)        return 1 ;;
  esac
}

# What Ollama models this project needs, matching scripts/ollama-host-setup.sh.
REQUIRED_MODELS=(
  "nomic-embed-text"
  "mashriram/sarvam-1"
  "MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M"
)

check_ollama() {
  step "Checking Ollama on the host"

  if ! ollama_local_ready; then
    warn "no Ollama answering on ${OLLAMA_LOCAL_URL}."
    dim "This app runs its models on the host rather than in a container."
    if [[ -x "$OLLAMA_SETUP_SCRIPT" ]]; then
      dim "Install it and the three models this project needs:"
      dim "    ./${OLLAMA_SETUP_SCRIPT}"
    else
      dim "See README.md, section 'Models on the host'."
    fi
    die "start Ollama first, then re-run. Nothing here can answer a question without it."
  fi
  ok "ollama is running"

  local tags missing=()
  tags="$(curl -s -m 10 "${OLLAMA_LOCAL_URL}/api/tags" 2>/dev/null || true)"
  for model in "${REQUIRED_MODELS[@]}"; do
    if ! printf '%s' "$tags" | grep -q ""${model%%:*}""; then
      missing+=("$model")
    fi
  done
  if (( ${#missing[@]} )); then
    warn "${#missing[@]} required model(s) not pulled: ${missing[*]}"
    if [[ -x "$OLLAMA_SETUP_SCRIPT" ]]; then
      dim "    ./${OLLAMA_SETUP_SCRIPT}    # pulls what is missing"
    fi
    dim "The app will start but retrieval and generation will fail until they are there."
  else
    ok "all ${#REQUIRED_MODELS[@]} required model(s) present"
  fi

  if ollama_reachable_from_container; then
    ok "the container can reach it at ${OLLAMA_CONTAINER_URL}"
  else
    warn "the container cannot reach Ollama at ${OLLAMA_CONTAINER_URL}."
    dim "Usually means Ollama is bound to 127.0.0.1 only, so there is no interface"
    dim "for the container to connect to. Rebind it:"
    if [[ -x "$OLLAMA_SETUP_SCRIPT" ]]; then
      dim "    ./${OLLAMA_SETUP_SCRIPT}"
    fi
    dim "That also exposes Ollama to your network, which it does not authenticate."
    die "fix the binding, or point OLLAMA_BASE_URL somewhere the container can reach."
  fi
}

# Locate a bundle in index-snapshots/.
#
#   0  prints the path, a bundle was found
#   1  there is genuinely no bundle here
#   2  a LATEST file exists but is unusable — a mistake, not an absence
#
# The three are kept apart deliberately. Treating a broken pointer as "no pointer"
# means quietly loading whichever directory happens to be the only one there, which
# is the opposite of what the file said and gives no sign anything was wrong.
snapshot_dir() {
  local root="${1:-index-snapshots}" pointer=""

  if [[ -f "$root/$LATEST_FILE" ]]; then
    pointer="$(tr -d '[:space:]' < "$root/$LATEST_FILE" || true)"
    if [[ -z "$pointer" ]]; then
      return 2
    fi
    # A pointer is one directory name. Anything with a path separator is refused
    # rather than resolved, so a doctored pointer cannot aim the importer outside
    # the mounted folder.
    if [[ "$pointer" == */* || "$pointer" == *\\* || "$pointer" == ".." ]]; then
      return 2
    fi
    if [[ ! -f "$root/$pointer/$MANIFEST_FILE" ]]; then
      return 2
    fi
    printf '%s/%s' "$root" "$pointer"
    return 0
  fi

  # No LATEST at all. A single bundle is still unambiguous, so use it.
  local found=()
  shopt -s nullglob
  found=("$root"/*/"$MANIFEST_FILE")
  shopt -u nullglob
  if (( ${#found[@]} == 1 )); then
    printf '%s' "${found[0]%/$MANIFEST_FILE}"
    return 0
  fi
  return 1
}

# Turn a snapshot_dir status of 2 into an explanation, then carry on with 1.
snapshot_or_explain() {
  local root="${1:-index-snapshots}" snap
  set +e
  snap="$(snapshot_dir "$root")"
  local rc=$?
  set -e
  case "$rc" in
    0) printf '%s' "$snap"; return 0 ;;
    2)
      warn "$root/$LATEST_FILE is present but unusable."
      if [[ -s "$root/$LATEST_FILE" ]]; then
        dim "it names: $(tr -d '[:space:]' < "$root/$LATEST_FILE")"
      else
        dim "it is empty"
      fi
      dim "It must name one bundle directory inside $root that contains a"
      dim "$MANIFEST_FILE, e.g. $(cat index-snapshots/LATEST 2>/dev/null || echo '20260927T115319Z-ollama-nomic-embed-text-768d')."
      dim "Delete the file to ignore snapshots and ingest from the PDFs instead."
      SNAPSHOT_MODE=never
      return 1
      ;;
    *) return 1 ;;
  esac
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

  local pdfs=()
  shopt -s nullglob
  pdfs=(data/pdfs/*.pdf data/pdfs/*.PDF)
  shopt -u nullglob
  if (( ${#pdfs[@]} == 0 )); then
    # Not a blocker any more. A prepared index needs no PDFs at all; only a real
    # ingest does, and the ingest step is what will say so if it gets there.
    if snapshot_dir >/dev/null 2>&1; then
      info "no PDFs in data/pdfs, but there is a prepared index to load from."
    else
      warn "no PDFs in data/pdfs, and no prepared index to fall back on."
      dim "This repository ships the corpus, so an empty data/pdfs/ means the PDFs"
      dim "were deleted or never checked out. Put them back with:"
      dim "    git checkout -- data/pdfs"
      dim "The app will start and answer everything with 'not found' until you do."
    fi
  else
    ok "${#pdfs[@]} PDF(s) in data/pdfs"
  fi

  if [[ "$SNAPSHOT_MODE" != never ]]; then
    local snap
    if [[ -f index-snapshots/$LATEST_FILE ]] && ! snap="$(snapshot_or_explain index-snapshots)"; then
      :  # snapshot_or_explain already explained it, and turned snapshots off
    elif [[ -n "${snap:-}" ]]; then
      ok "prepared index: $snap"
    else
      dim "no prepared index in index-snapshots/ — the corpus will be ingested from the PDFs"
    fi
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
  ok "stopped. The database is still there. Model weights live on the host."
}

do_reset() {
  step "Resetting"
  resolve_docker
  resolve_compose
  printf '  This deletes the database volume, so the next start re-loads the corpus.\n' >&2
  printf '  Model weights on the host are NOT touched.\n' >&2
  local answer
  read -r -p "  Type 'reset' to continue: " answer
  if [[ "$answer" != "reset" ]]; then
    info "cancelled. Nothing was deleted."
    return 0
  fi
  compose down -v
  ok "deleted. Next ./run.sh loads the corpus again from a snapshot or the PDFs."
}

do_logs() {
  resolve_docker
  resolve_compose
  compose logs -f app
}

do_up() {
  preflight
  ensure_env
  check_ollama

  step "Building and starting the stack"
  info "models live on the host, so this only builds the app image"
  compose up -d --build

  step "Waiting for each service to be actually ready"
  # Order mirrors depends_on, so the output reads as a narrative.
  if ! wait_healthy "$C_PGVECTOR" "postgres"; then
    warn "postgres never became healthy. Its logs:"
    show_logs pgvector 40
    die "the database did not come up. Nothing else can work until it does."
  fi

  if ! wait_healthy "$C_APP" "app"; then
    warn "the app never became healthy. Its logs:"
    show_logs app 40
    die "the app did not come up."
  fi

  maybe_load_corpus
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

maybe_load_corpus() {
  step "Corpus"
  if (( SKIP_INGEST )); then
    dim "skipped (--skip-ingest)"
    return 0
  fi

  local json chunks
  json="$(health_json)"
  chunks="$(chunk_count "$json")"

  if [[ "$chunks" =~ ^[0-9]+$ ]] && (( chunks > 0 )) && (( FORCE_INGEST == 0 )); then
    ok "corpus already has $chunks chunk(s) — skipping (--force-ingest to re-embed)"
    return 0
  fi

  # Empty. A prepared index is seconds; ingest is minutes, so try it first.
  if [[ "$SNAPSHOT_MODE" != never ]]; then
    local snap
    if snap="$(snapshot_or_explain index-snapshots)"; then
      if try_snapshot "$snap"; then
        return 0
      fi
      if [[ "$SNAPSHOT_MODE" == only ]]; then
        die "--import-snapshot was given and the bundle could not be used.
       The app is up and the database is empty, so it answers 'not found' to
       everything. Fix the mismatch above, or drop --import-snapshot to ingest."
      fi
      info "falling back to ingesting from the PDFs"
    fi
  fi

  ingest_pdfs
}

# Load a bundle. Returns 0 if the store is now populated, 1 to fall back.
#
# The importer does the real work of deciding whether the bundle is safe: it
# checks the embedding model against .env and verifies every checksum before it
# writes anything. This function's job is only to notice that the importer
# declined and explain it, so that --import-snapshot fails loudly instead of
# quietly producing an empty corpus.
try_snapshot() {
  local snap="$1" started=$SECONDS
  info "loading the prepared index from $snap"
  # --no-deps so Compose does not restart the running app for a one-off task.
  local log
  log="$(mktemp)"
  if compose run --rm --no-deps -T app npm run --silent index:import -- \
        --dir "/index-snapshots/$(basename "$snap")" >"$log" 2>&1; then
    sed 's/^/    /' "$log"
    local chunks now
    now="$(chunk_count "$(health_json)")"
    if [[ "$now" =~ ^[0-9]+$ ]] && (( now > 0 )); then
      rm -f "$log"
      ok "index loaded in $(( (SECONDS - started) / 60 ))m $(( (SECONDS - started) % 60 ))s — $now chunk(s)"
      # The PDFs are not in the bundle, so a missing corpus is worth saying
      # plainly here rather than letting someone find out by clicking a citation.
      if [[ -z "$(ls -A data/pdfs/*.pdf data/pdfs/*.PDF 2>/dev/null || true)" ]]; then
        dim "No PDFs in data/pdfs, so answers work but citation links will not open."
        dim "Copy the standards into data/pdfs/ to get them."
      fi
      return 0
    fi
    chunks="the importer reported success but the store is still empty"
  else
    chunks="$(grep -E '^\[import\]|^ *-' "$log" | head -20 || true)"
  fi
  rm -f "$log"
  warn "could not use that index:"
  [[ -n "$chunks" ]] && printf '%s\n' "$chunks" | sed 's/^/    /'
  return 1
}

ingest_pdfs() {
  local pdfs=()
  shopt -s nullglob
  pdfs=(data/pdfs/*.pdf data/pdfs/*.PDF)
  shopt -u nullglob
  if (( ${#pdfs[@]} == 0 )); then
    die "the corpus is empty and there is nothing to load it from.
       Either drop a prepared index into index-snapshots/, or put the BIS PDFs
       in data/pdfs/. The app is up and will answer 'not found' to everything
       until one of those is done."
  fi

  if (( FORCE_INGEST )); then
    info "--force-ingest: re-embedding everything"
  fi

  info "extracting, chunking and embedding ${#pdfs[@]} PDF(s). This runs locally on"
  info "CPU and can take 5-20 minutes for a few thousand chunks. Output streams"
  info "below — it is not stuck."
  local started=$SECONDS
  compose run --rm --no-deps -T app npm run --silent ingest
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
