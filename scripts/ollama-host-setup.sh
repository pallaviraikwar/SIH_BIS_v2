#!/usr/bin/env bash
#
# One-time host setup: make the Ollama daemon reachable from the app container.
#
#   ./scripts/ollama-host-setup.sh            set up, pull the three models
#   ./scripts/ollama-host-setup.sh --install  also install Ollama if missing
#   ./scripts/ollama-host-setup.sh --check     report only, change nothing
#   ./scripts/ollama-host-setup.sh --revert    put the daemon back on 127.0.0.1
#
# Why this exists, and why the app is not simply pointed at 127.0.0.1:
#
# The app runs in a container. A container has its own loopback, so
# http://127.0.0.1:11434 inside it is the *container's* 127.0.0.1, and Ollama is
# not listening there. The daemon therefore has to be bound to an address the
# bridge can reach, and the container has to be told what that address is.
#
# The alternative — keeping the ollama service inside docker-compose.yml — was the
# previous arrangement and it has a real cost: a second model store, so a second
# ~2.9 GB pull for weights the host already has, plus a root-ownership trap
# documented in the old compose file. One daemon on the host, one copy of the
# weights, no trap.
#
# Linux and WSL only. Needs sudo for exactly one thing: writing a systemd drop-in.
#
# SECURITY, and this is the one real cost of the arrangement
# ------------------------------------------------------
# Ollama's HTTP API has NO authentication. Anyone who can reach port 11434 can
# read every model on the machine, delete them, and run inference. Binding it to
# 0.0.0.0 therefore means "reachable from your local network", which is fine on a
# laptop on trusted wifi and wrong on shared or public wifi. The script prints
# this again at the end and offers --revert, which is the undo.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

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

# A drop-in, not an edit of /etc/systemd/system/ollama.service. The packaged unit
# belongs to the ollama package: editing it in place means `apt upgrade` either
# clobbers the change or asks about a modified config file. A drop-in in
# ollama.service.d/ survives both and is the mechanism systemd provides for
# exactly this.
DROPIN_DIR=/etc/systemd/system/ollama.service.d
DROPIN_PATH="$DROPIN_DIR/override.conf"

# These three, and not one fewer:
#
#   OLLAMA_HOST           the whole point of this script — the bind address
#   OLLAMA_KEEP_ALIVE     default is 5 minutes, and a cold load of a 2.5B model is
#                         a multi-second pause on the first question after a break
#   OLLAMA_CONTEXT_LENGTH correctness, not tuning. Ollama's default is 4,096 with
#                         no GPU, and a grounded prompt here is ~5,400-6,600
#                         tokens. The daemon does not reject an oversized prompt:
#                         it trims the evidence and still returns 200, so the
#                         model answers from a third of the passages with nothing
#                         reporting a problem.
#
# Identical to what docker-compose.yml used to set on its own ollama service, so
# switching to a host daemon changes where the weights live and nothing else.
DROPIN_BODY='# Managed by SIH_BIS_v2/scripts/ollama-host-setup.sh — do not edit by hand.
# The app container reaches the daemon through this address. Revert with:
#   ./scripts/ollama-host-setup.sh --revert
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_KEEP_ALIVE=-1"
Environment="OLLAMA_CONTEXT_LENGTH=8192"'

# The three models the app needs, and nothing else. Exactly the list that
# .env.example documents and that the removed compose `models` service used to
# pull, so the set is defined in one place now.
#
#   nomic-embed-text                     274 MB, 768-dim embeddings
#   mashriram/sarvam-1                   ~1.5 GB, generation
#   MedAIBase/Tencent-HY-MT1.5:1.8b-q4…  1.1 GB, Hindi/Telugu -> English
#
# The namespace matters: the registry name is "mashriram/sarvam-1". Plain
# "sarvam-1" is a different, untuned model and will not start.
MODELS=(
  nomic-embed-text
  mashriram/sarvam-1
  MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M
)

# ---------------------------------------------------------------- flags

MODE=setup
INSTALL=0

usage() {
  cat <<'EOF'
Usage: ./scripts/ollama-host-setup.sh [options]

  (no options)   bind the daemon so containers can reach it, pull the 3 models
  --install      install Ollama first if it is not on PATH
  --check        report the current state and change nothing (exit 0 if ready)
  --revert       remove the drop-in, put the daemon back on 127.0.0.1
  -h, --help     this text

Needs sudo for one thing: writing /etc/systemd/system/ollama.service.d/override.conf.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --check)   MODE=check ;;
    --revert)  MODE=revert ;;
    --help|-h) usage; exit 0 ;;
    *)         die "unknown option: $1  (try --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------- guards

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux) ;;
  Darwin)
    die "macOS is not supported by this script. Ollama runs as a launchd service
       there, not systemd. Set the same three values in
       ~/Library/LaunchAgents/com.ollama.server.plist and reload it."
    ;;
  MINGW*|MSYS*|CYGWIN*)
    die "this is Git Bash, which cannot manage the WSL systemd service.
       From PowerShell run:
         wsl -d Ubuntu -- bash -lc \"cd <wsl-path>/SIH_BIS_v2 && ./scripts/ollama-host-setup.sh\""
    ;;
  *)
    die "unsupported platform: $(uname -s). Linux or WSL only."
    ;;
esac

command -v systemctl >/dev/null 2>&1 \
  || die "systemd is not present. On WSL that usually means the WSL1 kernel; WSL2 is required."

# sudo is resolved once and reused, so the password is asked for a single time
# rather than on every systemctl call.
#
# Lazily, and only for the modes that actually write anything: `--check` is a
# read-only report and must work in a non-interactive context (CI, a script, a
# piped shell), so demanding elevation to print the state would be wrong.
SUDO=()
SUDO_READY=0

resolve_sudo() {
  (( SUDO_READY )) && return 0
  SUDO_READY=1
  if [[ "$(id -u)" -eq 0 ]]; then
    return 0
  fi
  command -v sudo >/dev/null 2>&1 \
    || die "need sudo to write $DROPIN_PATH, and sudo is not installed."
  if ! sudo -n true 2>/dev/null; then
    [[ -t 0 ]] || die "no terminal attached, so the sudo password cannot be asked for.
       Run this from an interactive terminal, or run these three by hand:
         sudo mkdir -p $DROPIN_DIR
         sudo tee $DROPIN_PATH > /dev/null   # paste the drop-in
         sudo systemctl daemon-reload && sudo systemctl restart ollama"
    info "asking for your password once, then reusing it (sudo -v)"
    sudo -v || die "sudo failed."
  fi
  SUDO=(sudo)
}

as_root() {
  (( SUDO_READY )) || resolve_sudo
  if [[ ${#SUDO[@]} -gt 0 ]]; then "${SUDO[@]}" "$@"; else "$@"; fi
}

# ---------------------------------------------------------------- ollama present

ensure_ollama_binary() {
  if command -v ollama >/dev/null 2>&1; then
    ok "ollama is installed: $(ollama --version 2>&1 | head -1)"
    return 0
  fi

  local hint='curl -fsSL https://ollama.com/install.sh | sh'
  if (( INSTALL )); then
    step "Installing Ollama"
    info "official installer: https://ollama.com/install.sh"
    info "$hint"
    # Not silent about what it is fetching: this is the documented upstream
    # installer, and --install is opt-in precisely so nobody runs a remote script
    # because a project README told them to.
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://ollama.com/install.sh | sh
    else
      die "curl is not installed. Install Ollama manually, then re-run:
         $hint"
    fi
    command -v ollama >/dev/null 2>&1 || die "the installer finished but 'ollama' is still not on PATH.
       Open a new shell (PATH is set up in your profile) and re-run this script."
    ok "installed: $(ollama --version 2>&1 | head -1)"
    return 0
  fi

  die "Ollama is not installed. Either:
       $hint
       or re-run with --install to have this script do it.
       On WSL, use the Microsoft Store's WSL build of Ollama rather than the
       Windows one — they are different binaries and the Windows one will not be
       reachable from inside Linux containers."
}

# ---------------------------------------------------------------- state

# The address the daemon is actually listening on, or empty.
#
# Strips only the trailing ":11434" rather than everything up to the last colon:
# for an IPv6 bind the address itself contains colons ("[::]:11434"), and
# `sub(/^.*:/,"")` would return the port number and report a perfectly good
# daemon as bound to nothing.
listen_addresses() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltn 2>/dev/null | awk '$4 ~ /:11434$/ { a = $4; sub(/:11434$/, "", a); print a }' | sort -u
}

models_installed() {
  ollama list 2>/dev/null | awk 'NR > 1 { print $1 }'
}

# Print the current state and say whether the host is ready.
#
# The return value is the useful output here, because `--check` is scripted
# against it and a report that printed "all 3 models present" while exiting 0
# with the daemon unreachable would be worse than no check at all. So every
# problem accumulates into `ready` and the function returns that, rather than
# returning early on the first one and hiding the rest.
report_state() {
  local ready=1 addrs m

  step "Current state"

  if ! command -v ollama >/dev/null 2>&1; then
    warn "ollama is not on PATH"
    return 1
  fi
  ok "ollama is installed: $(ollama --version 2>&1 | head -1)"

  if [[ -f "$DROPIN_PATH" ]]; then
    ok "drop-in present: $DROPIN_PATH"
  else
    warn "no drop-in at $DROPIN_PATH, so the daemon uses the packaged default
       bind address. Fix with:  ./scripts/ollama-host-setup.sh"
    ready=0
  fi

  # `ollama list` is a round trip to the HTTP server, so a successful call proves
  # both that the binary works and that the daemon is actually up. Same trick the
  # removed compose healthcheck used.
  if ! ollama list >/dev/null 2>&1; then
    warn "the daemon is not answering (systemctl status ollama)"
    return 1
  fi
  ok "daemon is answering"

  addrs="$(listen_addresses | tr '\n' ' ')"
  if [[ -z "$addrs" ]]; then
    warn "nothing is listening on port 11434 according to ss, yet the daemon
       answered. Check 'ss -ltnp | grep 11434'."
    ready=0
  elif [[ "$addrs" == *127.0.0.1* && "$addrs" != *0.0.0.0* && "$addrs" != *'::'* ]]; then
    # One call, not a warn followed by two dims: warn goes to stderr and dim to
    # stdout, so splitting the message across them interleaves it out of order
    # whenever the two streams are not a terminal.
    warn "bound to $addrs only, and a container CANNOT reach the host's
       loopback. This is the one thing that must be fixed:
         ./scripts/ollama-host-setup.sh"
    ready=0
  else
    ok "listening on $addrs — reachable from the Docker bridge"
  fi

  local missing=0
  for m in "${MODELS[@]}"; do
    if models_installed | grep -qF "$m"; then
      printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$m"
    else
      printf '  %s! %s%s\n' "$C_YELLOW" "$m" "$C_RESET" >&2
      missing=$((missing + 1))
    fi
  done
  if (( missing )); then
    warn "$missing of ${#MODELS[@]} model(s) missing"
    ready=0
  else
    ok "all ${#MODELS[@]} models present"
  fi

  return $(( ready == 1 ? 0 : 1 ))
}

# ---------------------------------------------------------------- actions

do_install_dropin() {
  step "Binding Ollama so containers can reach it"

  # Compare before writing, so a second run is a no-op rather than a needless
  # restart of the daemon — restarting it unloads whatever is resident, so the
  # first question after a redundant restart pays a multi-second model load.
  if [[ -f "$DROPIN_PATH" ]] && [[ "$(cat "$DROPIN_PATH")" == "$DROPIN_BODY" ]]; then
    ok "drop-in already correct, nothing to write"
  else
    as_root mkdir -p "$DROPIN_DIR"
    # printf with an explicit \n rather than `echo "$DROPIN_BODY"`: the body has
    # no trailing newline (so the comparison above is exact, since `$(cat f)`
    # strips them), and echo's behaviour with escapes is not portable.
    printf '%s\n' "$DROPIN_BODY" | as_root tee "$DROPIN_PATH" >/dev/null
    ok "wrote $DROPIN_PATH"
  fi

  as_root systemctl daemon-reload
  ok "daemon-reload done"
}

do_revert() {
  step "Reverting to a loopback-only daemon"
  if [[ ! -f "$DROPIN_PATH" ]]; then
    ok "no drop-in to remove — already on the packaged defaults"
  else
    as_root rm -f "$DROPIN_PATH"
    # An empty ollama.service.d/ is harmless, but remove it so the revert is
    # complete rather than leaving a stub behind.
    as_root rmdir "$DROPIN_DIR" 2>/dev/null || true
    ok "removed $DROPIN_PATH"
  fi
  as_root systemctl daemon-reload
  as_root systemctl restart ollama
  ok "daemon restarted; it is back on 127.0.0.1:11434"
  warn "docker-compose.yml now points the app at host.docker.internal, so the stack
       will no longer reach the models. Either re-run this script without
       --revert, or run Ollama inside Docker instead."
}

do_pull_models() {
  step "Models"
  local m before
  local -a missing=()
  for m in "${MODELS[@]}"; do
    if models_installed | grep -qF "$m"; then
      ok "$m already present"
    else
      missing+=("$m")
    fi
  done

  if (( ${#missing[@]} == 0 )); then
    ok "nothing to pull"
    return 0
  fi

  info "pulling ${#missing[@]} model(s), ~2.9 GB on a cold machine"
  for m in "${missing[@]}"; do
    # Not quiet: a silent multi-minute download reads as a hang, and the first
    # thing anyone does when a setup looks stuck is kill it.
    if ollama pull "$m"; then
      ok "pulled $m"
    else
      die "failed to pull $m. Check your network, then re-run — already-pulled
       models are skipped, so nothing is downloaded twice."
    fi
  done
}

do_finish() {
  step "Verify"
  if ! report_state; then
    die "the host is not ready yet. Fix what is listed above and re-run."
  fi

  step "Next"
  ok "the host is ready. Start the stack with:"
  printf '    %s%s%s\n' "$C_BOLD" "cd $REPO_DIR && ./run.sh" "$C_RESET"

  cat >&2 <<EOF

$(printf '%s' "$C_DIM")
  Reminder: Ollama's HTTP API has no authentication, so anything that can reach
  port 11434 on this machine can read and delete your models and run inference.
  On a trusted network that is fine. On shared or public wifi, undo this with
  ./scripts/ollama-host-setup.sh --revert
  $(printf '%s' "$C_RESET")
EOF
}

# ---------------------------------------------------------------- main

case "$MODE" in
  check)
    if report_state; then exit 0; else exit 1; fi
    ;;
  revert)
    do_revert
    ;;
  setup)
    ensure_ollama_binary
    do_install_dropin
    as_root systemctl enable --now ollama
    as_root systemctl restart ollama
    ok "ollama service enabled and restarted"
    do_pull_models
    do_finish
    ;;
esac
