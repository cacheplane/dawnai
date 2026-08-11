#!/bin/sh
# sandbox-docker-e2e assertions (docker-out-of-docker / DooD).
#
# Drives a containerized Dawn app over the Agent Protocol and proves that a
# real, non-root, read-only sibling sandbox executes runBash and is destroyed.
set -eu

# Keep timeout reports visible when callers suppress a command's own stderr.
exec 3>&2

# --- Parameters -------------------------------------------------------------
APP_IMAGE="${APP_IMAGE:-dawn-smoke-app:docker}"
AIMOCK_IMAGE="${AIMOCK_IMAGE:-dawn-smoke-aimock:latest}"
NET="${NET:-dawn-smoke-net}"
APP_NAME="${APP_NAME:-dawn-smoke-app}"
AIMOCK_NAME="${AIMOCK_NAME:-dawn-smoke-aimock}"
APP_PORT="${APP_PORT:-8000}"
AIMOCK_PORT="${AIMOCK_PORT:-4010}"
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
SMOKE_COMMAND_TIMEOUT_SECONDS="${SMOKE_COMMAND_TIMEOUT_SECONDS:-30}"
SMOKE_COMMAND_KILL_GRACE_SECONDS="${SMOKE_COMMAND_KILL_GRACE_SECONDS:-2}"
SMOKE_RUN_CURL_MAX_TIME_SECONDS="${SMOKE_RUN_CURL_MAX_TIME_SECONDS:-240}"
SMOKE_RUN_TIMEOUT_SECONDS="${SMOKE_RUN_TIMEOUT_SECONDS:-245}"
BASE="http://127.0.0.1:${APP_PORT}"
ROUTE='/smoke#agent'
SBX_PREFIX="dawn-sbx-"
SBX_VOL_PREFIX="dawn-sbx-vol-"

case "$SMOKE_COMMAND_TIMEOUT_SECONDS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_COMMAND_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_COMMAND_KILL_GRACE_SECONDS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_COMMAND_KILL_GRACE_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_RUN_CURL_MAX_TIME_SECONDS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_RUN_CURL_MAX_TIME_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_RUN_TIMEOUT_SECONDS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_RUN_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac
if [ "$SMOKE_RUN_TIMEOUT_SECONDS" -le "$SMOKE_RUN_CURL_MAX_TIME_SECONDS" ]; then
  echo "ASSERT FAILED: SMOKE_RUN_TIMEOUT_SECONDS must exceed SMOKE_RUN_CURL_MAX_TIME_SECONDS" >&2
  exit 1
fi

for REQUIRED_COMMAND in docker curl jq awk grep sed tr sleep cat mkdir rm; do
  command -v "$REQUIRED_COMMAND" >/dev/null 2>&1 || {
    echo "ASSERT FAILED: required command '${REQUIRED_COMMAND}' is unavailable" >&2
    exit 1
  }
done

# --- Bounded command execution ---------------------------------------------
# Private contract: callers run sequential CLI commands that do not daemonize
# or intentionally leave descendants behind. Only the direct child is owned.
umask 077
SMOKE_RUN_DIRECTORY=""
RB_SETUP_ACTIVE=0
RB_COMMAND_PID=""
RB_WATCHDOG_PID=""
RB_SIGNAL_NAME=""
RB_SIGNAL_STATUS=0

initialize_smoke_run_directory() {
  SMOKE_TMP_ROOT=${TMPDIR:-/tmp}
  SMOKE_TMP_ROOT=${SMOKE_TMP_ROOT%/}
  [ -n "$SMOKE_TMP_ROOT" ] || SMOKE_TMP_ROOT=/tmp
  SMOKE_TMP_ATTEMPT=0
  while [ "$SMOKE_TMP_ATTEMPT" -lt 100 ]; do
    SMOKE_RUN_DIRECTORY="${SMOKE_TMP_ROOT}/dawn-docker-smoke.$$.${SMOKE_TMP_ATTEMPT}"
    if mkdir "$SMOKE_RUN_DIRECTORY" 2>/dev/null; then
      return 0
    fi
    SMOKE_TMP_ATTEMPT=$((SMOKE_TMP_ATTEMPT + 1))
  done
  SMOKE_RUN_DIRECTORY=""
  return 1
}

cleanup_smoke_run_directory() {
  if [ -n "$SMOKE_RUN_DIRECTORY" ]; then
    rm -rf "$SMOKE_RUN_DIRECTORY"
    SMOKE_RUN_DIRECTORY=""
  fi
}

restore_smoke_signal_traps() {
  if [ "$EXIT_ACTIVE" = "1" ]; then
    trap - HUP INT TERM
  else
    trap 'handle_hup' HUP
    trap 'handle_int' INT
    trap 'handle_term' TERM
  fi
}

settle_bounded_signal() {
  trap '' HUP INT TERM

  if [ -n "$RB_WATCHDOG_PID" ]; then
    kill -TERM "$RB_WATCHDOG_PID" 2>/dev/null || :
    wait "$RB_WATCHDOG_PID" 2>/dev/null || :
    RB_WATCHDOG_PID=""
  fi

  if [ -n "$RB_COMMAND_PID" ]; then
    RB_SETTLE_COMMAND_PID=$RB_COMMAND_PID
    kill -"$RB_SIGNAL_NAME" "$RB_SETTLE_COMMAND_PID" 2>/dev/null || :
    run_bounded_signal_watchdog "$RB_SETTLE_COMMAND_PID" "$RB_COMPLETION_MARKER" \
      >/dev/null 2>&1 &
    RB_WATCHDOG_PID=$!
    wait "$RB_SETTLE_COMMAND_PID" 2>/dev/null || :
    printf 'complete\n' >"$RB_COMPLETION_MARKER"
    RB_COMMAND_PID=""
    kill -TERM "$RB_WATCHDOG_PID" 2>/dev/null || :
    wait "$RB_WATCHDOG_PID" 2>/dev/null || :
    RB_WATCHDOG_PID=""
  fi

  SIGNAL_NAME=$RB_SIGNAL_NAME
  exit "$RB_SIGNAL_STATUS"
}

handle_bounded_signal() {
  RB_SIGNAL_NAME=$1
  RB_SIGNAL_STATUS=$2
  if [ "$RB_SETUP_ACTIVE" = "1" ] && [ -z "$RB_COMMAND_PID" ]; then return 0; fi
  settle_bounded_signal
}

run_bounded_signal_watchdog() {
  RB_SW_COMMAND_PID=$1
  RB_SW_COMPLETION_MARKER=$2
  RB_SW_SLEEP_PID=""

  trap '
    if [ -n "$RB_SW_SLEEP_PID" ]; then
      kill -TERM "$RB_SW_SLEEP_PID" 2>/dev/null || :
      wait "$RB_SW_SLEEP_PID" 2>/dev/null || :
    fi
    exit 0
  ' HUP INT TERM

  sleep "$SMOKE_COMMAND_KILL_GRACE_SECONDS" >/dev/null 2>&1 &
  RB_SW_SLEEP_PID=$!
  wait "$RB_SW_SLEEP_PID" 2>/dev/null || exit 0
  RB_SW_SLEEP_PID=""
  [ ! -s "$RB_SW_COMPLETION_MARKER" ] || exit 0
  kill -KILL "$RB_SW_COMMAND_PID" 2>/dev/null || :
}

run_bounded_watchdog() {
  RB_WD_COMMAND_PID=$1
  RB_WD_TIMEOUT_SECONDS=$2
  RB_WD_TIMEOUT_MARKER=$3
  RB_WD_KILL_MARKER=$4
  RB_WD_COMPLETION_MARKER=$5
  RB_WD_SLEEP_PID=""

  trap '
    if [ -n "$RB_WD_SLEEP_PID" ]; then
      kill -TERM "$RB_WD_SLEEP_PID" 2>/dev/null || :
      wait "$RB_WD_SLEEP_PID" 2>/dev/null || :
    fi
    exit 0
  ' HUP INT TERM

  sleep "$RB_WD_TIMEOUT_SECONDS" >/dev/null 2>&1 &
  RB_WD_SLEEP_PID=$!
  wait "$RB_WD_SLEEP_PID" 2>/dev/null || exit 0
  RB_WD_SLEEP_PID=""
  [ ! -s "$RB_WD_COMPLETION_MARKER" ] || exit 0

  printf 'timeout\n' >"$RB_WD_TIMEOUT_MARKER"
  kill -TERM "$RB_WD_COMMAND_PID" 2>/dev/null || exit 0

  sleep "$SMOKE_COMMAND_KILL_GRACE_SECONDS" >/dev/null 2>&1 &
  RB_WD_SLEEP_PID=$!
  wait "$RB_WD_SLEEP_PID" 2>/dev/null || exit 0
  RB_WD_SLEEP_PID=""
  [ ! -s "$RB_WD_COMPLETION_MARKER" ] || exit 0
  if kill -0 "$RB_WD_COMMAND_PID" 2>/dev/null; then
    printf 'kill\n' >"$RB_WD_KILL_MARKER"
    kill -KILL "$RB_WD_COMMAND_PID" 2>/dev/null || :
  fi
}

run_bounded_for() {
  RB_TIMEOUT_SECONDS=$1
  shift
  RB_COMMAND_LABEL=$*
  RB_STDOUT_PATH="${SMOKE_RUN_DIRECTORY}/command.stdout"
  RB_STDERR_PATH="${SMOKE_RUN_DIRECTORY}/command.stderr"
  RB_TIMEOUT_MARKER="${SMOKE_RUN_DIRECTORY}/command.timeout"
  RB_KILL_MARKER="${SMOKE_RUN_DIRECTORY}/command.kill"
  RB_COMPLETION_MARKER="${SMOKE_RUN_DIRECTORY}/command.complete"
  : >"$RB_STDOUT_PATH"
  : >"$RB_STDERR_PATH"
  : >"$RB_TIMEOUT_MARKER"
  : >"$RB_KILL_MARKER"
  : >"$RB_COMPLETION_MARKER"

  RB_SETUP_ACTIVE=1
  RB_COMMAND_PID=""
  RB_WATCHDOG_PID=""
  RB_SIGNAL_NAME=""
  RB_SIGNAL_STATUS=0
  trap 'handle_bounded_signal HUP 129' HUP
  trap 'handle_bounded_signal INT 130' INT
  trap 'handle_bounded_signal TERM 143' TERM

  "$@" <&0 >"$RB_STDOUT_PATH" 2>"$RB_STDERR_PATH" &
  RB_COMMAND_PID=$!
  RB_SETUP_ACTIVE=0
  if [ -n "$RB_SIGNAL_NAME" ]; then settle_bounded_signal; fi

  run_bounded_watchdog "$RB_COMMAND_PID" "$RB_TIMEOUT_SECONDS" \
    "$RB_TIMEOUT_MARKER" "$RB_KILL_MARKER" "$RB_COMPLETION_MARKER" \
    >/dev/null 2>&1 &
  RB_WATCHDOG_PID=$!

  RB_COMMAND_STATUS=0
  wait "$RB_COMMAND_PID" || RB_COMMAND_STATUS=$?
  printf 'complete\n' >"$RB_COMPLETION_MARKER"
  RB_COMMAND_PID=""

  kill -TERM "$RB_WATCHDOG_PID" 2>/dev/null || :
  wait "$RB_WATCHDOG_PID" 2>/dev/null || :
  RB_WATCHDOG_PID=""
  restore_smoke_signal_traps

  if [ -s "$RB_STDOUT_PATH" ]; then cat "$RB_STDOUT_PATH"; fi
  if [ -s "$RB_STDERR_PATH" ]; then cat "$RB_STDERR_PATH" >&2; fi
  if [ -s "$RB_TIMEOUT_MARKER" ]; then
    printf 'COMMAND TIMEOUT after %ss: %s; sending TERM\n' \
      "$RB_TIMEOUT_SECONDS" "$RB_COMMAND_LABEL" >&3
    if [ -s "$RB_KILL_MARKER" ]; then
      printf 'COMMAND TIMEOUT grace expired after %ss: %s; sending KILL\n' \
        "$SMOKE_COMMAND_KILL_GRACE_SECONDS" "$RB_COMMAND_LABEL" >&3
    fi
    return 124
  fi
  return "$RB_COMMAND_STATUS"
}

run_bounded() {
  run_bounded_for "$SMOKE_COMMAND_TIMEOUT_SECONDS" "$@"
}

read_container_id() {
  if READ_VALUE=$(run_bounded docker inspect --format '{{.Id}}' "$1" 2>/dev/null); then
    printf '%s' "$READ_VALUE" | tr -d '\r\n'
    return 0
  else
    READ_STATUS=$?
    return "$READ_STATUS"
  fi
}

read_network_id() {
  if READ_VALUE=$(run_bounded docker network inspect --format '{{.Id}}' "$1" 2>/dev/null); then
    printf '%s' "$READ_VALUE" | tr -d '\r\n'
    return 0
  else
    READ_STATUS=$?
    return "$READ_STATUS"
  fi
}

list_exact_container_ids() {
  LIST_TARGET=$1
  if LIST_ROWS=$(run_bounded docker ps -a --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null); then :; else
    LIST_STATUS=$?
    return "$LIST_STATUS"
  fi
  if LIST_VALUE=$(
    printf '%s\n' "$LIST_ROWS" |
      awk -v target="$LIST_TARGET" "{ sub(/\r$/, \"\"); if (\$2 == target) print \$1 }"
  ); then
    printf '%s' "$LIST_VALUE"
    return 0
  else
    LIST_STATUS=$?
    return "$LIST_STATUS"
  fi
}

list_exact_network_ids() {
  LIST_TARGET=$1
  if LIST_ROWS=$(run_bounded docker network ls --no-trunc --format '{{.ID}} {{.Name}}' 2>/dev/null); then :; else
    LIST_STATUS=$?
    return "$LIST_STATUS"
  fi
  if LIST_VALUE=$(
    printf '%s\n' "$LIST_ROWS" |
      awk -v target="$LIST_TARGET" "{ sub(/\r$/, \"\"); if (\$2 == target) print \$1 }"
  ); then
    printf '%s' "$LIST_VALUE"
    return 0
  else
    LIST_STATUS=$?
    return "$LIST_STATUS"
  fi
}

list_exact_volume_names() {
  LIST_TARGET=$1
  if LIST_ROWS=$(run_bounded docker volume ls --format '{{.Name}}' 2>/dev/null); then :; else
    LIST_STATUS=$?
    return "$LIST_STATUS"
  fi
  if LIST_VALUE=$(
    printf '%s\n' "$LIST_ROWS" |
      awk -v target="$LIST_TARGET" "{ sub(/\r$/, \"\"); if (\$1 == target) print \$1 }"
  ); then
    printf '%s' "$LIST_VALUE"
    return 0
  else
    LIST_STATUS=$?
    return "$LIST_STATUS"
  fi
}

read_container_format() {
  READ_FORMAT=$1
  READ_TARGET=$2
  if READ_VALUE=$(run_bounded docker inspect --format "$READ_FORMAT" "$READ_TARGET" 2>/dev/null); then
    printf '%s' "$READ_VALUE" | tr -d '\r\n'
    return 0
  else
    READ_STATUS=$?
    return "$READ_STATUS"
  fi
}

read_sandbox_thread_label() {
  read_container_format '{{ index .Config.Labels "dawn.sandbox" }}' "$1"
}

read_sandbox_identity_label() {
  read_container_format '{{ index .Config.Labels "dawn.sandbox.identity" }}' "$1"
}

read_volume_fingerprint() {
  READ_VOLUME_NAME=$1
  if READ_VOLUME_JSON=$(
    run_bounded docker volume inspect "$READ_VOLUME_NAME" 2>/dev/null
  ); then :; else
    READ_STATUS=$?
    return "$READ_STATUS"
  fi

  if READ_VALUE=$(
    printf '%s' "$READ_VOLUME_JSON" |
      jq -cS '.[0] | {CreatedAt, Driver, Labels, Mountpoint, Name, Options, Scope}'
  ); then
    printf '%s' "$READ_VALUE" | tr -d '\r\n'
    return 0
  else
    READ_STATUS=$?
    return "$READ_STATUS"
  fi
}

# --- Ownership state --------------------------------------------------------
SIGNAL_NAME="NONE"
EXIT_ACTIVE=0
RUN_STARTED=0
NETWORK_PREFLIGHT_CLEAR=0
AIMOCK_PREFLIGHT_CLEAR=0
APP_PREFLIGHT_CLEAR=0
SBX_PREFLIGHT_CLEAR=0
VOL_PREFLIGHT_CLEAR=0
SBX_ADOPTION_STATE="not_started"
NETWORK_CREATE_STATE="not_started"
AIMOCK_CREATE_STATE="not_started"
APP_CREATE_STATE="not_started"
APP_REMOVAL_REQUIRED=0
APP_QUIESCED=0
APP_QUIESCENCE_HAD_ERROR=0

NETWORK_ID=""
AIMOCK_ID=""
APP_ID=""
TID=""
SANITIZED_TID=""
SBX_NAME=""
SBX_VOLUME_NAME=""
SBX_ID=""
SBX_THREAD_LABEL=""
SBX_IDENTITY_LABEL=""
SBX_VOLUME_FINGERPRINT=""

fail() {
  echo "ASSERT FAILED: $*" >&2
  exit 1
}

is_full_object_id() {
  [ "${#1}" = "64" ] || return 1
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

reject_network_claim() {
  NETWORK_CREATE_STATE="rejected"
  NETWORK_ID=""
}

reject_aimock_claim() {
  AIMOCK_CREATE_STATE="rejected"
  AIMOCK_ID=""
}

reject_app_claim() {
  APP_CREATE_STATE="rejected"
  APP_ID=""
}

assert_exact_container_absent() {
  ABSENT_NAME=$1
  ABSENT_DESCRIPTION=$2
  if ABSENT_IDS=$(list_exact_container_ids "$ABSENT_NAME"); then :; else
    fail "could not verify absence of ${ABSENT_DESCRIPTION} '${ABSENT_NAME}'"
  fi
  [ -z "$ABSENT_IDS" ] ||
    fail "${ABSENT_DESCRIPTION} '${ABSENT_NAME}' is occupied by container ${ABSENT_IDS}; refusing to continue"
}

assert_exact_network_absent() {
  ABSENT_NAME=$1
  if ABSENT_IDS=$(list_exact_network_ids "$ABSENT_NAME"); then :; else
    fail "could not verify absence of network '${ABSENT_NAME}'"
  fi
  [ -z "$ABSENT_IDS" ] ||
    fail "network '${ABSENT_NAME}' is occupied by object ${ABSENT_IDS}; refusing to continue"
}

assert_exact_volume_absent() {
  ABSENT_NAME=$1
  if ABSENT_NAMES=$(list_exact_volume_names "$ABSENT_NAME"); then :; else
    fail "could not verify absence of sandbox volume '${ABSENT_NAME}'"
  fi
  [ -z "$ABSENT_NAMES" ] ||
    fail "sandbox volume '${ABSENT_NAME}' is occupied; refusing to continue"
}

assert_no_sandbox_occupancy() {
  if OCCUPIED_CONTAINERS=$(
    run_bounded docker ps -aq --no-trunc --filter "name=${SBX_PREFIX}" 2>/dev/null
  ); then :; else
    fail "could not preflight ${SBX_PREFIX}* containers"
  fi
  if [ -n "$OCCUPIED_CONTAINERS" ]; then
    fail "a ${SBX_PREFIX}* sandbox container is occupied; refusing to continue"
  fi

  if OCCUPIED_VOLUMES=$(
    run_bounded docker volume ls -q --filter "name=${SBX_VOL_PREFIX}" 2>/dev/null
  ); then :; else
    fail "could not preflight ${SBX_VOL_PREFIX}* volumes"
  fi
  if [ -n "$OCCUPIED_VOLUMES" ]; then
    fail "a ${SBX_VOL_PREFIX}* sandbox volume is occupied; refusing to continue"
  fi
}

adopt_ambiguous_network_claim() {
  case "$NETWORK_CREATE_STATE" in
    pending) ;;
    not_started | claimed | absent | rejected) return 0 ;;
    *)
      echo "CLEANUP OWNERSHIP ERROR: invalid network create state '${NETWORK_CREATE_STATE}'" >&2
      reject_network_claim
      return 1
      ;;
  esac
  if [ -n "$NETWORK_ID" ]; then
    echo "CLEANUP OWNERSHIP ERROR: pending network create unexpectedly has an immutable ID" >&2
    reject_network_claim
    return 1
  fi
  if [ "$NETWORK_PREFLIGHT_CLEAR" != "1" ]; then
    echo "CLEANUP OWNERSHIP ERROR: ambiguous network create did not pass preflight" >&2
    reject_network_claim
    return 1
  fi
  if ADOPTED_FIXED_IDS=$(list_exact_network_ids "$NET"); then :; else
    echo "CLEANUP OWNERSHIP ERROR: ambiguous network create could not be resolved" >&2
    reject_network_claim
    return 1
  fi
  ADOPTED_FIXED_COUNT=$(printf '%s\n' "$ADOPTED_FIXED_IDS" | grep -c . || true)
  if [ "$ADOPTED_FIXED_COUNT" = "0" ]; then
    NETWORK_CREATE_STATE="absent"
    return 0
  fi
  if [ "$ADOPTED_FIXED_COUNT" != "1" ] || ! is_full_object_id "$ADOPTED_FIXED_IDS"; then
    echo "CLEANUP OWNERSHIP ERROR: ambiguous network create returned an invalid exact-name identity" >&2
    reject_network_claim
    return 1
  fi
  NETWORK_ID=$ADOPTED_FIXED_IDS
  NETWORK_CREATE_STATE="claimed"
}

adopt_ambiguous_aimock_claim() {
  case "$AIMOCK_CREATE_STATE" in
    pending) ;;
    not_started | claimed | absent | rejected) return 0 ;;
    *)
      echo "CLEANUP OWNERSHIP ERROR: invalid aimock create state '${AIMOCK_CREATE_STATE}'" >&2
      reject_aimock_claim
      return 1
      ;;
  esac
  if [ -n "$AIMOCK_ID" ]; then
    echo "CLEANUP OWNERSHIP ERROR: pending aimock create unexpectedly has an immutable ID" >&2
    reject_aimock_claim
    return 1
  fi
  if [ "$AIMOCK_PREFLIGHT_CLEAR" != "1" ]; then
    echo "CLEANUP OWNERSHIP ERROR: ambiguous aimock create did not pass preflight" >&2
    reject_aimock_claim
    return 1
  fi
  if ADOPTED_FIXED_IDS=$(list_exact_container_ids "$AIMOCK_NAME"); then :; else
    echo "CLEANUP OWNERSHIP ERROR: ambiguous aimock create could not be resolved" >&2
    reject_aimock_claim
    return 1
  fi
  ADOPTED_FIXED_COUNT=$(printf '%s\n' "$ADOPTED_FIXED_IDS" | grep -c . || true)
  if [ "$ADOPTED_FIXED_COUNT" = "0" ]; then
    AIMOCK_CREATE_STATE="absent"
    return 0
  fi
  if [ "$ADOPTED_FIXED_COUNT" != "1" ] || ! is_full_object_id "$ADOPTED_FIXED_IDS"; then
    echo "CLEANUP OWNERSHIP ERROR: ambiguous aimock create returned an invalid exact-name identity" >&2
    reject_aimock_claim
    return 1
  fi
  AIMOCK_ID=$ADOPTED_FIXED_IDS
  AIMOCK_CREATE_STATE="claimed"
}

adopt_ambiguous_app_claim() {
  case "$APP_CREATE_STATE" in
    pending) ;;
    not_started | claimed | absent | rejected) return 0 ;;
    *)
      echo "CLEANUP OWNERSHIP ERROR: invalid app create state '${APP_CREATE_STATE}'" >&2
      reject_app_claim
      return 1
      ;;
  esac
  if [ -n "$APP_ID" ]; then
    echo "CLEANUP OWNERSHIP ERROR: pending app create unexpectedly has an immutable ID" >&2
    reject_app_claim
    return 1
  fi
  if [ "$APP_PREFLIGHT_CLEAR" != "1" ]; then
    echo "CLEANUP OWNERSHIP ERROR: ambiguous app create did not pass preflight" >&2
    reject_app_claim
    return 1
  fi
  if ADOPTED_FIXED_IDS=$(list_exact_container_ids "$APP_NAME"); then :; else
    echo "CLEANUP OWNERSHIP ERROR: ambiguous app create could not be resolved" >&2
    reject_app_claim
    return 1
  fi
  ADOPTED_FIXED_COUNT=$(printf '%s\n' "$ADOPTED_FIXED_IDS" | grep -c . || true)
  if [ "$ADOPTED_FIXED_COUNT" = "0" ]; then
    APP_CREATE_STATE="absent"
    APP_QUIESCED=1
    return 0
  fi
  if [ "$ADOPTED_FIXED_COUNT" != "1" ] || ! is_full_object_id "$ADOPTED_FIXED_IDS"; then
    echo "CLEANUP OWNERSHIP ERROR: ambiguous app create returned an invalid exact-name identity" >&2
    reject_app_claim
    return 1
  fi
  APP_ID=$ADOPTED_FIXED_IDS
  APP_CREATE_STATE="claimed"
}

adopt_ambiguous_fixed_claims() {
  AMBIGUOUS_ADOPTION_RESULT=0
  adopt_ambiguous_app_claim || AMBIGUOUS_ADOPTION_RESULT=1
  adopt_ambiguous_aimock_claim || AMBIGUOUS_ADOPTION_RESULT=1
  adopt_ambiguous_network_claim || AMBIGUOUS_ADOPTION_RESULT=1
  return "$AMBIGUOUS_ADOPTION_RESULT"
}

invalidate_sandbox_claims() {
  SBX_ID=""
  SBX_THREAD_LABEL=""
  SBX_IDENTITY_LABEL=""
  SBX_VOLUME_FINGERPRINT=""
}

reject_sandbox_claims() {
  invalidate_sandbox_claims
  SBX_ADOPTION_STATE="rejected"
}

adopt_sandbox_claims() {
  ADOPTION_PHASE=${1:-active}

  case "$SBX_ADOPTION_STATE" in
    adopted)
      if [ "$ADOPTION_PHASE" != "final" ]; then
        return 0
      fi
      FINAL_ADOPTION_RESULT=0
      validate_sandbox_claim || FINAL_ADOPTION_RESULT=1
      validate_volume_claim || FINAL_ADOPTION_RESULT=1
      return "$FINAL_ADOPTION_RESULT"
      ;;
    absent)
      if [ "$ADOPTION_PHASE" = "final" ]; then
        SBX_ADOPTION_STATE="pending"
      else
        return 0
      fi
      ;;
    rejected) return 1 ;;
    not_started) SBX_ADOPTION_STATE="pending" ;;
    pending | container_adopted) ;;
    *)
      echo "CLEANUP OWNERSHIP ERROR: invalid sandbox adoption state '${SBX_ADOPTION_STATE}'" >&2
      reject_sandbox_claims
      return 1
      ;;
  esac

  if [ "$RUN_STARTED" != "1" ] || [ "$SBX_PREFLIGHT_CLEAR" != "1" ]; then
    echo "CLEANUP OWNERSHIP ERROR: sandbox container did not pass preflight" >&2
    reject_sandbox_claims
    return 1
  fi

  if [ "$SBX_ADOPTION_STATE" = "pending" ]; then
    if [ "$ADOPTION_PHASE" = "final" ]; then
      if ADOPTED_IDS=$(list_exact_container_ids "$SBX_NAME"); then :; else
        echo "CLEANUP OWNERSHIP ERROR: final sandbox container listing failed" >&2
        return 1
      fi
      ADOPTED_COUNT=$(printf '%s\n' "$ADOPTED_IDS" | grep -c . || true)
      if [ "$ADOPTED_COUNT" = "0" ]; then
        if ADOPTED_VOLUME_NAMES=$(list_exact_volume_names "$SBX_VOLUME_NAME"); then :; else
          echo "CLEANUP OWNERSHIP ERROR: final sandbox volume listing failed" >&2
          return 1
        fi
        if [ -z "$ADOPTED_VOLUME_NAMES" ]; then
          SBX_ADOPTION_STATE="absent"
          return 0
        fi
        echo "CLEANUP OWNERSHIP ERROR: sandbox volume exists without an attributable sandbox container" >&2
        reject_sandbox_claims
        return 1
      fi
      if [ "$ADOPTED_COUNT" != "1" ]; then
        echo "CLEANUP OWNERSHIP ERROR: final sandbox container listing returned ${ADOPTED_COUNT} exact matches" >&2
        reject_sandbox_claims
        return 1
      fi
      ADOPTED_ID=$ADOPTED_IDS
    elif ADOPTED_ID=$(read_container_id "$SBX_NAME"); then :; else
      echo "CLEANUP OWNERSHIP ERROR: expected sandbox container '${SBX_NAME}' was not observed after run start" >&2
      return 1
    fi

    if ADOPTED_THREAD_LABEL=$(read_sandbox_thread_label "$ADOPTED_ID"); then :; else
      echo "CLEANUP OWNERSHIP ERROR: could not read dawn.sandbox label from ${ADOPTED_ID}" >&2
      return 1
    fi
    if [ "$ADOPTED_THREAD_LABEL" != "$SANITIZED_TID" ]; then
      echo "CLEANUP OWNERSHIP ERROR: sandbox label '${ADOPTED_THREAD_LABEL}' does not equal '${SANITIZED_TID}'" >&2
      reject_sandbox_claims
      return 1
    fi
    if ADOPTED_IDENTITY=$(read_sandbox_identity_label "$ADOPTED_ID"); then :; else
      echo "CLEANUP OWNERSHIP ERROR: could not read sandbox identity label from ${ADOPTED_ID}" >&2
      return 1
    fi
    if ! printf '%s\n' "$ADOPTED_IDENTITY" | grep -Eq '^[0-9a-f]{64}$'; then
      echo "CLEANUP OWNERSHIP ERROR: sandbox identity label is not 64 lowercase hexadecimal characters" >&2
      reject_sandbox_claims
      return 1
    fi

    SBX_ID=$ADOPTED_ID
    SBX_THREAD_LABEL=$ADOPTED_THREAD_LABEL
    SBX_IDENTITY_LABEL=$ADOPTED_IDENTITY
    SBX_ADOPTION_STATE="container_adopted"
  fi

  if [ "$VOL_PREFLIGHT_CLEAR" != "1" ]; then
    echo "CLEANUP OWNERSHIP ERROR: sandbox volume did not pass preflight" >&2
    reject_sandbox_claims
    return 1
  fi
  if [ "$ADOPTION_PHASE" = "final" ]; then
    if ADOPTED_VOLUME_NAMES=$(list_exact_volume_names "$SBX_VOLUME_NAME"); then :; else
      echo "CLEANUP OWNERSHIP ERROR: final sandbox volume listing failed" >&2
      return 1
    fi
    if [ -z "$ADOPTED_VOLUME_NAMES" ]; then
      SBX_ADOPTION_STATE="adopted"
      return 0
    fi
    if [ "$ADOPTED_VOLUME_NAMES" != "$SBX_VOLUME_NAME" ]; then
      echo "CLEANUP OWNERSHIP ERROR: final exact sandbox volume listing changed" >&2
      SBX_VOLUME_FINGERPRINT=""
      return 1
    fi
  fi
  if ADOPTED_VOLUME_FINGERPRINT=$(read_volume_fingerprint "$SBX_VOLUME_NAME"); then
    SBX_VOLUME_FINGERPRINT=$ADOPTED_VOLUME_FINGERPRINT
    SBX_ADOPTION_STATE="adopted"
  else
    echo "CLEANUP OWNERSHIP ERROR: expected sandbox volume '${SBX_VOLUME_NAME}' was not observed after run start" >&2
    return 1
  fi
}

validate_app_claim() {
  [ -n "$APP_ID" ] || return 0
  if LIVE_IDS=$(list_exact_container_ids "$APP_NAME"); then :; else
    echo "CLEANUP OWNERSHIP ERROR: app container ownership listing failed" >&2
    return 1
  fi
  if [ -z "$LIVE_IDS" ]; then
    APP_CREATE_STATE="absent"
    APP_ID=""
    APP_QUIESCED=1
    return 0
  fi
  if [ "$LIVE_IDS" = "$APP_ID" ]; then return 0; fi
  echo "CLEANUP OWNERSHIP ERROR: app container '${APP_NAME}' changed from ${APP_ID} to ${LIVE_IDS}; skipping replacement" >&2
  reject_app_claim
  return 1
}

validate_aimock_claim() {
  [ -n "$AIMOCK_ID" ] || return 0
  if LIVE_IDS=$(list_exact_container_ids "$AIMOCK_NAME"); then :; else
    echo "CLEANUP OWNERSHIP ERROR: aimock container ownership listing failed" >&2
    reject_aimock_claim
    return 1
  fi
  if [ -z "$LIVE_IDS" ]; then
    AIMOCK_CREATE_STATE="absent"
    AIMOCK_ID=""
    return 0
  fi
  if [ "$LIVE_IDS" = "$AIMOCK_ID" ]; then return 0; fi
  echo "CLEANUP OWNERSHIP ERROR: aimock container '${AIMOCK_NAME}' changed from ${AIMOCK_ID} to ${LIVE_IDS}; skipping replacement" >&2
  reject_aimock_claim
  return 1
}

validate_network_claim() {
  [ -n "$NETWORK_ID" ] || return 0
  if LIVE_IDS=$(list_exact_network_ids "$NET"); then :; else
    echo "CLEANUP OWNERSHIP ERROR: network ownership listing failed" >&2
    reject_network_claim
    return 1
  fi
  if [ -z "$LIVE_IDS" ]; then
    NETWORK_CREATE_STATE="absent"
    NETWORK_ID=""
    return 0
  fi
  if [ "$LIVE_IDS" = "$NETWORK_ID" ]; then return 0; fi
  echo "CLEANUP OWNERSHIP ERROR: network '${NET}' changed from ${NETWORK_ID} to ${LIVE_IDS}; skipping replacement" >&2
  reject_network_claim
  return 1
}

validate_sandbox_claim() {
  [ -n "$SBX_ID" ] || return 0
  if LIVE_IDS=$(list_exact_container_ids "$SBX_NAME"); then :; else
    reject_sandbox_claims
    echo "CLEANUP OWNERSHIP ERROR: sandbox container ownership listing failed; invalidating container and volume claims" >&2
    return 1
  fi
  if [ -z "$LIVE_IDS" ]; then
    SBX_ID=""
    SBX_THREAD_LABEL=""
    SBX_IDENTITY_LABEL=""
    return 0
  fi
  if [ "$LIVE_IDS" != "$SBX_ID" ]; then
    echo "CLEANUP OWNERSHIP ERROR: sandbox container '${SBX_NAME}' changed from ${SBX_ID} to ${LIVE_IDS}; invalidating container and volume claims" >&2
    reject_sandbox_claims
    return 1
  fi
  if LIVE_THREAD_LABEL=$(read_sandbox_thread_label "$SBX_ID"); then :; else
    echo "CLEANUP OWNERSHIP ERROR: sandbox thread label could not be revalidated; invalidating container and volume claims" >&2
    reject_sandbox_claims
    return 1
  fi
  if LIVE_IDENTITY=$(read_sandbox_identity_label "$SBX_ID"); then :; else
    echo "CLEANUP OWNERSHIP ERROR: sandbox identity label could not be revalidated; invalidating container and volume claims" >&2
    reject_sandbox_claims
    return 1
  fi
  if [ "$LIVE_THREAD_LABEL" != "$SBX_THREAD_LABEL" ] || [ "$LIVE_THREAD_LABEL" != "$SANITIZED_TID" ]; then
    echo "CLEANUP OWNERSHIP ERROR: sandbox thread label changed; invalidating container and volume claims" >&2
    reject_sandbox_claims
    return 1
  fi
  if [ "$LIVE_IDENTITY" != "$SBX_IDENTITY_LABEL" ]; then
    echo "CLEANUP OWNERSHIP ERROR: sandbox identity label changed; invalidating container and volume claims" >&2
    reject_sandbox_claims
    return 1
  fi
}

validate_volume_claim() {
  [ -n "$SBX_VOLUME_FINGERPRINT" ] || return 0
  if LIVE_NAMES=$(list_exact_volume_names "$SBX_VOLUME_NAME"); then :; else
    SBX_VOLUME_FINGERPRINT=""
    echo "CLEANUP OWNERSHIP ERROR: sandbox volume ownership listing failed" >&2
    return 1
  fi
  if [ -z "$LIVE_NAMES" ]; then
    SBX_VOLUME_FINGERPRINT=""
    return 0
  fi
  if [ "$LIVE_NAMES" != "$SBX_VOLUME_NAME" ]; then
    SBX_VOLUME_FINGERPRINT=""
    echo "CLEANUP OWNERSHIP ERROR: exact sandbox volume listing changed; skipping replacement" >&2
    return 1
  fi
  if LIVE_FINGERPRINT=$(read_volume_fingerprint "$SBX_VOLUME_NAME"); then
    if [ "$LIVE_FINGERPRINT" = "$SBX_VOLUME_FINGERPRINT" ]; then return 0; fi
    echo "CLEANUP OWNERSHIP ERROR: sandbox volume fingerprint changed; skipping replacement" >&2
    SBX_VOLUME_FINGERPRINT=""
    return 1
  fi
  SBX_VOLUME_FINGERPRINT=""
  echo "CLEANUP OWNERSHIP ERROR: sandbox volume fingerprint could not be revalidated" >&2
  return 1
}

validate_claims() {
  VALIDATION_RESULT=0
  validate_app_claim || VALIDATION_RESULT=1
  validate_aimock_claim || VALIDATION_RESULT=1
  validate_network_claim || VALIDATION_RESULT=1
  validate_sandbox_claim || VALIDATION_RESULT=1
  validate_volume_claim || VALIDATION_RESULT=1
  return "$VALIDATION_RESULT"
}

collect_diagnostics() {
  DIAGNOSTIC_STATUS=$1
  echo "----- diagnostics status=${DIAGNOSTIC_STATUS} signal=${SIGNAL_NAME} -----" >&2
  echo "----- sandbox container prefix entries (max 50, read-only) -----" >&2
  run_bounded docker ps -a --filter "name=${SBX_PREFIX}" --format '{{.ID}} {{.Names}}' 2>&1 |
    sed -n '1,50p' >&2 || true
  echo "----- sandbox volume prefix entries (max 50, read-only) -----" >&2
  run_bounded docker volume ls -q --filter "name=${SBX_VOL_PREFIX}" 2>&1 |
    sed -n '1,50p' >&2 || true
  if [ -n "$APP_ID" ]; then
    echo "----- app logs (${APP_ID}) -----" >&2
    run_bounded docker logs "$APP_ID" --tail=150 >&2 2>&1 || true
  fi
  if [ -n "$AIMOCK_ID" ]; then
    echo "----- aimock logs (${AIMOCK_ID}) -----" >&2
    run_bounded docker logs "$AIMOCK_ID" --tail=60 >&2 2>&1 || true
  fi
  if [ -n "$SBX_ID" ]; then
    echo "----- sandbox inspect (${SBX_ID}) -----" >&2
    run_bounded docker inspect "$SBX_ID" >&2 2>&1 || true
  fi
  return 0
}

remove_container_claim() {
  REMOVE_ID=$1
  REMOVE_DESCRIPTION=$2
  if run_bounded docker rm -f "$REMOVE_ID" >/dev/null 2>&1; then return 0; fi
  echo "CLEANUP ERROR: failed to remove owned ${REMOVE_DESCRIPTION} ${REMOVE_ID}" >&2
  return 1
}

remove_network_claim() {
  if run_bounded docker network rm "$NETWORK_ID" >/dev/null 2>&1; then return 0; fi
  echo "CLEANUP ERROR: failed to remove owned network ${NETWORK_ID}" >&2
  return 1
}

remove_volume_claim() {
  if LIVE_NAMES=$(list_exact_volume_names "$SBX_VOLUME_NAME"); then :; else
    SBX_VOLUME_FINGERPRINT=""
    echo "CLEANUP OWNERSHIP ERROR: sandbox volume listing failed immediately before removal" >&2
    return 1
  fi
  if [ -z "$LIVE_NAMES" ]; then
    SBX_VOLUME_FINGERPRINT=""
    return 0
  fi
  if [ "$LIVE_NAMES" != "$SBX_VOLUME_NAME" ]; then
    SBX_VOLUME_FINGERPRINT=""
    echo "CLEANUP OWNERSHIP ERROR: exact sandbox volume listing changed immediately before removal" >&2
    return 1
  fi
  if LIVE_FINGERPRINT=$(read_volume_fingerprint "$SBX_VOLUME_NAME"); then
    if [ "$LIVE_FINGERPRINT" != "$SBX_VOLUME_FINGERPRINT" ]; then
      echo "CLEANUP OWNERSHIP ERROR: sandbox volume fingerprint changed immediately before removal; skipping replacement" >&2
      SBX_VOLUME_FINGERPRINT=""
      return 1
    fi
  else
    SBX_VOLUME_FINGERPRINT=""
    echo "CLEANUP OWNERSHIP ERROR: sandbox volume could not be revalidated immediately before removal" >&2
    return 1
  fi
  if run_bounded docker volume rm "$SBX_VOLUME_NAME" >/dev/null 2>&1; then
    SBX_VOLUME_FINGERPRINT=""
    return 0
  fi
  echo "CLEANUP ERROR: failed to remove owned sandbox volume '${SBX_VOLUME_NAME}'" >&2
  return 1
}

quiesce_app_claim() {
  if [ "$APP_REMOVAL_REQUIRED" != "1" ]; then
    APP_QUIESCED=1
    return 0
  fi
  [ "$APP_QUIESCED" = "1" ] && return 0
  if [ -z "$APP_ID" ]; then
    echo "CLEANUP OWNERSHIP ERROR: app removal cannot be confirmed without its immutable ID" >&2
    return 1
  fi

  QUIESCE_APP_ID=$APP_ID
  QUIESCE_REMOVE_STATUS=0
  run_bounded docker rm -f "$QUIESCE_APP_ID" >/dev/null 2>&1 || QUIESCE_REMOVE_STATUS=$?
  if [ "$QUIESCE_REMOVE_STATUS" != "0" ]; then APP_QUIESCENCE_HAD_ERROR=1; fi
  if QUIESCE_ROWS=$(
    run_bounded docker ps -a --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null
  ); then :; else
    echo "CLEANUP OWNERSHIP ERROR: app absence could not be confirmed after removal; skipping sandbox cleanup" >&2
    return 1
  fi
  if QUIESCE_ID_MATCHES=$(
    printf '%s\n' "$QUIESCE_ROWS" |
      awk -v target="$QUIESCE_APP_ID" "{ sub(/\r$/, \"\"); if (\$1 == target) print \$2 }"
  ); then :; else
    echo "CLEANUP OWNERSHIP ERROR: app immutable-ID confirmation failed after removal; skipping sandbox cleanup" >&2
    return 1
  fi
  if QUIESCE_NAME_MATCHES=$(
    printf '%s\n' "$QUIESCE_ROWS" |
      awk -v target="$APP_NAME" "{ sub(/\r$/, \"\"); if (\$2 == target) print \$1 }"
  ); then :; else
    echo "CLEANUP OWNERSHIP ERROR: app exact-name confirmation failed after removal; skipping sandbox cleanup" >&2
    return 1
  fi
  if [ -n "$QUIESCE_ID_MATCHES" ]; then
    echo "CLEANUP OWNERSHIP ERROR: app container ID still exists after removal (status=${QUIESCE_REMOVE_STATUS}); skipping sandbox cleanup" >&2
    return 1
  fi
  if [ -n "$QUIESCE_NAME_MATCHES" ]; then
    echo "CLEANUP OWNERSHIP ERROR: app container was replaced during removal (status=${QUIESCE_REMOVE_STATUS}); skipping sandbox cleanup" >&2
    reject_app_claim
    return 1
  fi

  if [ "$QUIESCE_REMOVE_STATUS" != "0" ]; then
    echo "CLEANUP NOTE: app removal returned ${QUIESCE_REMOVE_STATUS}, but immutable ID and exact name are absent" >&2
  fi
  APP_CREATE_STATE="absent"
  APP_ID=""
  APP_QUIESCED=1
  return 0
}

cleanup_owned() {
  CLEANUP_RESULT=0
  if ! quiesce_app_claim; then
    if [ -n "$AIMOCK_ID" ]; then
      if remove_container_claim "$AIMOCK_ID" "aimock container"; then
        AIMOCK_CREATE_STATE="absent"
      else
        reject_aimock_claim
      fi
      AIMOCK_ID=""
    fi
    if [ -n "$NETWORK_ID" ]; then
      if remove_network_claim; then
        NETWORK_CREATE_STATE="absent"
      else
        reject_network_claim
      fi
      NETWORK_ID=""
    fi
    return 1
  fi
  if [ "$APP_QUIESCENCE_HAD_ERROR" = "1" ]; then CLEANUP_RESULT=1; fi

  if [ "$RUN_STARTED" = "1" ]; then
    adopt_sandbox_claims final || CLEANUP_RESULT=1
  fi

  if [ -n "$AIMOCK_ID" ]; then
    if remove_container_claim "$AIMOCK_ID" "aimock container"; then
      AIMOCK_CREATE_STATE="absent"
    else
      reject_aimock_claim
      CLEANUP_RESULT=1
    fi
    AIMOCK_ID=""
  fi
  SANDBOX_CONTAINER_REMOVED=1
  if [ -n "$SBX_ID" ]; then
    if remove_container_claim "$SBX_ID" "sandbox container"; then
      SBX_ID=""
      SBX_THREAD_LABEL=""
      SBX_IDENTITY_LABEL=""
    else
      CLEANUP_RESULT=1
      SANDBOX_CONTAINER_REMOVED=0
    fi
  fi
  if [ "$SANDBOX_CONTAINER_REMOVED" = "1" ] && [ -n "$SBX_VOLUME_FINGERPRINT" ]; then
    remove_volume_claim || CLEANUP_RESULT=1
  fi
  if [ -n "$NETWORK_ID" ]; then
    if remove_network_claim; then
      NETWORK_CREATE_STATE="absent"
    else
      reject_network_claim
      CLEANUP_RESULT=1
    fi
    NETWORK_ID=""
  fi
  return "$CLEANUP_RESULT"
}

emit_diagnostic_snapshot() {
  if [ "$DIAGNOSTICS_EMITTED" = "0" ]; then
    printf '%s\n' "$DIAGNOSTIC_SNAPSHOT" >&2
    DIAGNOSTICS_EMITTED=1
  fi
}

handle_exit() {
  ORIGINAL_STATUS=$1
  if [ "$EXIT_ACTIVE" = "1" ]; then return; fi
  EXIT_ACTIVE=1
  trap - EXIT HUP INT TERM
  set +e

  FINAL_STATUS=$ORIGINAL_STATUS
  EXIT_VALIDATION_FAILED=0
  EXIT_CLEANUP_FAILED=0
  DIAGNOSTICS_EMITTED=0
  case "$SBX_ADOPTION_STATE" in
    pending | container_adopted) adopt_sandbox_claims active || : ;;
  esac
  adopt_ambiguous_fixed_claims || EXIT_VALIDATION_FAILED=1
  validate_claims || EXIT_VALIDATION_FAILED=1

  if DIAGNOSTIC_SNAPSHOT=$(collect_diagnostics "$ORIGINAL_STATUS" 3>&1 2>&1); then :; else
    DIAGNOSTIC_SNAPSHOT="----- diagnostics status=${ORIGINAL_STATUS} signal=${SIGNAL_NAME} -----
DIAGNOSTIC ERROR: pre-cleanup snapshot could not be captured"
  fi

  if [ "$ORIGINAL_STATUS" != "0" ] || [ "$EXIT_VALIDATION_FAILED" != "0" ]; then
    emit_diagnostic_snapshot
  fi

  validate_claims || EXIT_VALIDATION_FAILED=1
  if [ "$EXIT_VALIDATION_FAILED" != "0" ]; then emit_diagnostic_snapshot; fi
  cleanup_owned || EXIT_CLEANUP_FAILED=1
  if [ "$EXIT_CLEANUP_FAILED" != "0" ]; then emit_diagnostic_snapshot; fi
  if [ "$EXIT_VALIDATION_FAILED" != "0" ] || [ "$EXIT_CLEANUP_FAILED" != "0" ]; then FINAL_STATUS=1; fi
  cleanup_smoke_run_directory
  exit "$FINAL_STATUS"
}

handle_hup() {
  SIGNAL_NAME="HUP"
  exit 129
}

handle_int() {
  SIGNAL_NAME="INT"
  exit 130
}

handle_term() {
  SIGNAL_NAME="TERM"
  exit 143
}

initialize_smoke_run_directory || {
  echo "ASSERT FAILED: could not create private bounded-command directory" >&2
  exit 1
}
trap 'handle_hup' HUP
trap 'handle_int' INT
trap 'handle_term' TERM
trap 'handle_exit $?' EXIT

# Extract runBash stdout from runs/wait or state response message shapes.
extract_tool_content() {
  printf '%s' "$1" | jq -r '
    (.messages // .values.messages // [])
    | map(select(
        ( ((.id? // []) | if type=="array" then (.[-1] // "") else . end) == "ToolMessage" )
        or (.type? == "tool")
      ))
    | map(select(((.kwargs.name? // .name?) == "runBash")))
    | (.[0] // {})
    | (.kwargs.content? // .content? // "")
    | (try fromjson catch .)
    | (if type == "object" then (.stdout // "") else . end)
  '
}

assert_expected_sandbox_set() {
  if EXACT_OBSERVED_IDS=$(list_exact_container_ids "$SBX_NAME"); then :; else
    fail "could not query exact sandbox container after runs/wait"
  fi
  EXACT_OBSERVED_COUNT=$(printf '%s\n' "$EXACT_OBSERVED_IDS" | grep -c . || true)
  if [ "$EXACT_OBSERVED_COUNT" != "1" ] || [ "$EXACT_OBSERVED_IDS" != "$SBX_ID" ]; then
    fail "exact sandbox container identity changed after runs/wait (count=${EXACT_OBSERVED_COUNT})"
  fi

  if OBSERVED_IDS=$(
    run_bounded docker ps -aq --no-trunc --filter "name=${SBX_PREFIX}" 2>/dev/null
  ); then :; else
    fail "could not list sandbox containers after runs/wait"
  fi
  OBSERVED_COUNT=$(printf '%s\n' "$OBSERVED_IDS" | grep -c . || true)
  if [ "$OBSERVED_COUNT" != "1" ] || [ "$OBSERVED_IDS" != "$SBX_ID" ]; then
    fail "unexpected concurrent sandbox container set after runs/wait (count=${OBSERVED_COUNT})"
  fi

  if OBSERVED_VOLUMES=$(
    run_bounded docker volume ls -q --filter "name=${SBX_VOL_PREFIX}" 2>/dev/null
  ); then :; else
    fail "could not list sandbox volumes after runs/wait"
  fi
  OBSERVED_VOLUME_COUNT=$(printf '%s\n' "$OBSERVED_VOLUMES" | grep -c . || true)
  if [ "$OBSERVED_VOLUME_COUNT" != "1" ] || [ "$OBSERVED_VOLUMES" != "$SBX_VOLUME_NAME" ]; then
    fail "unexpected concurrent sandbox volume set after runs/wait (count=${OBSERVED_VOLUME_COUNT})"
  fi
}

poll_exact_sandbox_names() {
  if [ -n "$SBX_ID" ]; then
    if POLL_IDS=$(list_exact_container_ids "$SBX_NAME"); then :; else
      echo "CLEANUP OWNERSHIP ERROR: sandbox absence listing failed after Agent Protocol DELETE" >&2
      invalidate_sandbox_claims
      return 1
    fi
    if [ -n "$POLL_IDS" ]; then
      if [ "$POLL_IDS" != "$SBX_ID" ]; then
        echo "CLEANUP OWNERSHIP ERROR: sandbox container changed after Agent Protocol DELETE" >&2
        invalidate_sandbox_claims
        return 1
      fi
      if POLL_THREAD=$(read_sandbox_thread_label "$SBX_ID") &&
        POLL_IDENTITY=$(read_sandbox_identity_label "$SBX_ID"); then :; else
        echo "CLEANUP OWNERSHIP ERROR: sandbox labels changed after Agent Protocol DELETE" >&2
        invalidate_sandbox_claims
        return 1
      fi
      if [ "$POLL_THREAD" != "$SBX_THREAD_LABEL" ] || [ "$POLL_IDENTITY" != "$SBX_IDENTITY_LABEL" ]; then
        echo "CLEANUP OWNERSHIP ERROR: sandbox labels changed after Agent Protocol DELETE" >&2
        invalidate_sandbox_claims
        return 1
      fi
    else
      SBX_ID=""
      SBX_THREAD_LABEL=""
      SBX_IDENTITY_LABEL=""
    fi
  fi

  if [ -n "$SBX_VOLUME_FINGERPRINT" ]; then
    if POLL_NAMES=$(list_exact_volume_names "$SBX_VOLUME_NAME"); then :; else
      echo "CLEANUP OWNERSHIP ERROR: sandbox volume absence listing failed after Agent Protocol DELETE" >&2
      SBX_VOLUME_FINGERPRINT=""
      return 1
    fi
    if [ -n "$POLL_NAMES" ]; then
      if [ "$POLL_NAMES" != "$SBX_VOLUME_NAME" ]; then
        echo "CLEANUP OWNERSHIP ERROR: exact sandbox volume listing changed after Agent Protocol DELETE" >&2
        SBX_VOLUME_FINGERPRINT=""
        return 1
      fi
      if POLL_FINGERPRINT=$(read_volume_fingerprint "$SBX_VOLUME_NAME"); then :; else
        echo "CLEANUP OWNERSHIP ERROR: sandbox volume fingerprint read failed after Agent Protocol DELETE" >&2
        SBX_VOLUME_FINGERPRINT=""
        return 1
      fi
      if [ "$POLL_FINGERPRINT" != "$SBX_VOLUME_FINGERPRINT" ]; then
        echo "CLEANUP OWNERSHIP ERROR: sandbox volume changed after Agent Protocol DELETE" >&2
        SBX_VOLUME_FINGERPRINT=""
        return 1
      fi
    else
      SBX_VOLUME_FINGERPRINT=""
    fi
  fi
}

# --- 0. preflight -----------------------------------------------------------
run_bounded docker info >/dev/null 2>&1 || fail "host docker daemon not reachable (DooD needs a working host docker)"
assert_exact_container_absent "$APP_NAME" "app container"
APP_PREFLIGHT_CLEAR=1
assert_exact_container_absent "$AIMOCK_NAME" "aimock container"
AIMOCK_PREFLIGHT_CLEAR=1
assert_exact_network_absent "$NET"
NETWORK_PREFLIGHT_CLEAR=1
assert_no_sandbox_occupancy

if SOCK_GID_RAW=$(
  run_bounded docker run --rm -v "${DOCKER_SOCK}:/var/run/docker.sock" \
    --entrypoint sh "$APP_IMAGE" -c 'stat -c %g /var/run/docker.sock 2>/dev/null'
); then :; else
  fail "could not probe the docker socket group gid (is ${DOCKER_SOCK} mountable?)"
fi
SOCK_GID=$(printf '%s' "$SOCK_GID_RAW" | tr -dc '0-9')
[ -n "$SOCK_GID" ] || fail "could not probe the docker socket group gid (is ${DOCKER_SOCK} mountable?)"
echo "==> docker socket group gid = ${SOCK_GID}"

# --- 1. create fixed resources and capture exact IDs ------------------------
NETWORK_CREATE_STATE="pending"
NETWORK_CREATE_STATUS=0
CREATED_NETWORK_ID=""
CREATED_NETWORK_ID=$(run_bounded docker network create "$NET" 2>/dev/null) || NETWORK_CREATE_STATUS=$?
if is_full_object_id "$CREATED_NETWORK_ID"; then
  NETWORK_ID=$CREATED_NETWORK_ID NETWORK_CREATE_STATE="claimed"
fi
[ "$NETWORK_CREATE_STATUS" = "0" ] || fail "failed to create network ${NET}"
[ -n "$NETWORK_ID" ] || fail "network create did not return a valid immutable ID"
if REVALIDATED_NETWORK_ID=$(read_network_id "$NET"); then :; else
  fail "failed to capture exact network ID after creating ${NET}"
fi
[ "$REVALIDATED_NETWORK_ID" = "$NETWORK_ID" ] || {
  reject_network_claim
  fail "network ownership changed between creation and identity capture; refusing replacement"
}
echo "==> network ${NET} ready (${NETWORK_ID})"

AIMOCK_CREATE_STATE="pending"
AIMOCK_CREATE_STATUS=0
CREATED_AIMOCK_ID=""
CREATED_AIMOCK_ID=$(
  run_bounded docker run -d --name "$AIMOCK_NAME" --network "$NET" "$AIMOCK_IMAGE"
) || AIMOCK_CREATE_STATUS=$?
if is_full_object_id "$CREATED_AIMOCK_ID"; then
  AIMOCK_ID=$CREATED_AIMOCK_ID AIMOCK_CREATE_STATE="claimed"
fi
[ "$AIMOCK_CREATE_STATUS" = "0" ] || fail "failed to start aimock container"
[ -n "$AIMOCK_ID" ] || fail "aimock create did not return a valid immutable ID"
if REVALIDATED_AIMOCK_ID=$(read_container_id "$AIMOCK_NAME"); then :; else
  fail "failed to capture exact aimock container ID"
fi
[ "$REVALIDATED_AIMOCK_ID" = "$AIMOCK_ID" ] || {
  reject_aimock_claim
  fail "aimock ownership changed between creation and identity capture; refusing replacement"
}
echo "==> aimock ${AIMOCK_NAME} started (${AIMOCK_ID})"

APP_CREATE_STATE="pending"
APP_REMOVAL_REQUIRED=1
APP_CREATE_STATUS=0
CREATED_APP_ID=""
CREATED_APP_ID=$(
  run_bounded docker run -d --name "$APP_NAME" --network "$NET" \
    -v "${DOCKER_SOCK}:/var/run/docker.sock" \
    --group-add "$SOCK_GID" \
    -e DAWN_SMOKE_SANDBOX=docker \
    -e DAWN_PERMISSIONS_MODE=bypass \
    -e "OPENAI_BASE_URL=http://${AIMOCK_NAME}:${AIMOCK_PORT}/v1" \
    -e OPENAI_API_KEY=dummy \
    -p "${APP_PORT}:8000" \
    "$APP_IMAGE"
) || APP_CREATE_STATUS=$?
if is_full_object_id "$CREATED_APP_ID"; then
  APP_ID=$CREATED_APP_ID APP_CREATE_STATE="claimed"
fi
[ "$APP_CREATE_STATUS" = "0" ] || fail "failed to start app container"
[ -n "$APP_ID" ] || fail "app create did not return a valid immutable ID"
if REVALIDATED_APP_ID=$(read_container_id "$APP_NAME"); then :; else
  fail "failed to capture exact app container ID"
fi
[ "$REVALIDATED_APP_ID" = "$APP_ID" ] || {
  reject_app_claim
  fail "app ownership changed between creation and identity capture; refusing replacement"
}
echo "==> app ${APP_NAME} started (${APP_ID})"

# --- 2. wait for /healthz ---------------------------------------------------
ready=""
i=0
while [ "$i" -lt 90 ]; do
  if run_bounded curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if LIVE_APP_ID=$(read_container_id "$APP_NAME"); then
    if [ "$LIVE_APP_ID" != "$APP_ID" ]; then
      reject_app_claim
      fail "app container ownership changed before /healthz became reachable"
    fi
  else
    fail "app container exited before /healthz became reachable"
  fi
  i=$((i + 1))
  sleep 1
done
[ -n "$ready" ] || fail "app /healthz never became reachable at ${BASE}"
echo "==> app reachable at ${BASE} (/healthz 200)"

# --- 3. create thread and preflight exact derived sandbox names -------------
if THREAD_JSON=$(
  run_bounded curl -fsS -X POST "${BASE}/threads" -H 'content-type: application/json' -d '{}'
); then :; else
  fail "POST /threads request failed"
fi
if TID=$(printf '%s' "$THREAD_JSON" | jq -r '.thread_id // empty'); then :; else
  fail "could not parse POST /threads response"
fi
[ -n "$TID" ] || fail "no thread_id in POST /threads response: $THREAD_JSON"
SANITIZED_TID=$(printf '%s' "$TID" | sed 's/[^a-zA-Z0-9_.-]/_/g')
SBX_NAME="${SBX_PREFIX}${SANITIZED_TID}"
SBX_VOLUME_NAME="${SBX_VOL_PREFIX}${SANITIZED_TID}"
echo "==> thread_id=$TID (sandbox=${SBX_NAME}, volume=${SBX_VOLUME_NAME})"

assert_no_sandbox_occupancy
assert_exact_container_absent "$SBX_NAME" "derived sandbox container"
SBX_PREFLIGHT_CLEAR=1
assert_exact_volume_absent "$SBX_VOLUME_NAME"
VOL_PREFLIGHT_CLEAR=1

# --- 4. run and adopt exact sandbox ownership -------------------------------
RUN_STARTED=1
SBX_ADOPTION_STATE="pending"
if RUN_JSON=$(
  run_bounded_for "$SMOKE_RUN_TIMEOUT_SECONDS" \
    curl -fsS --max-time "$SMOKE_RUN_CURL_MAX_TIME_SECONDS" \
    -X POST "${BASE}/threads/${TID}/runs/wait" \
    -H 'content-type: application/json' \
    -d "{\"route\":\"${ROUTE}\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"identify the sandbox\"}]}}"
); then :; else
  fail "POST /threads/${TID}/runs/wait request failed"
fi

adopt_sandbox_claims || fail "sandbox ownership could not be adopted after runs/wait"
assert_expected_sandbox_set

# --- 5. assert on the genuine runBash tool result ---------------------------
if CONTENT=$(extract_tool_content "$RUN_JSON"); then :; else
  fail "could not parse runBash tool-result content"
fi
if [ -z "$CONTENT" ] || [ "$CONTENT" = "null" ]; then
  echo "==> runs/wait carried no runBash tool message; falling back to GET /state" >&2
  if STATE_JSON=$(run_bounded curl -fsS "${BASE}/threads/${TID}/state"); then :; else
    fail "GET /threads/${TID}/state failed"
  fi
  if CONTENT=$(extract_tool_content "$STATE_JSON"); then :; else
    fail "could not parse runBash tool-result content from state"
  fi
fi
if [ -z "$CONTENT" ] || [ "$CONTENT" = "null" ]; then
  fail "no runBash tool-result content in run output or state"
fi

UID_LINE=$(printf '%s\n' "$CONTENT" | sed -n '1p' | tr -d '\r')
HOST_LINE=$(printf '%s\n' "$CONTENT" | sed -n '2p' | tr -d '\r')
echo "==> tool result: uid='${UID_LINE}' host='${HOST_LINE}'"
[ "$UID_LINE" = "1000" ] ||
  fail "expected non-root uid 1000 on line 1, got '${UID_LINE}' (content: ${CONTENT})"
[ -n "$HOST_LINE" ] ||
  fail "expected a sandbox hostname on line 2, got empty (content: ${CONTENT})"

if APP_HOSTNAME=$(read_container_format '{{.Config.Hostname}}' "$APP_ID"); then :; else
  fail "could not inspect the owned app container hostname"
fi
[ "$HOST_LINE" != "$APP_HOSTNAME" ] ||
  fail "tool-result hostname '${HOST_LINE}' equals app container hostname; command ran in the app"

if SBX_USER=$(read_container_format '{{.Config.User}}' "$SBX_ID"); then :; else
  fail "could not inspect owned sandbox container user"
fi
if SBX_ROROOTFS=$(read_container_format '{{.HostConfig.ReadonlyRootfs}}' "$SBX_ID"); then :; else
  fail "could not inspect owned sandbox rootfs setting"
fi
if SBX_HOSTNAME=$(read_container_format '{{.Config.Hostname}}' "$SBX_ID"); then :; else
  fail "could not inspect owned sandbox hostname"
fi
if SBX_INSPECTED_NAME=$(read_container_format '{{.Name}}' "$SBX_ID"); then :; else
  fail "could not inspect owned sandbox name"
fi
SBX_INSPECTED_NAME=$(printf '%s' "$SBX_INSPECTED_NAME" | sed 's#^/##')
[ "$SBX_INSPECTED_NAME" = "$SBX_NAME" ] ||
  fail "sandbox container name changed from '${SBX_NAME}' to '${SBX_INSPECTED_NAME}'"
echo "==> sandbox container ${SBX_NAME} user='${SBX_USER}' readonlyRootfs='${SBX_ROROOTFS}' hostname='${SBX_HOSTNAME}'"

case "$SBX_USER" in
  "1000:1000" | "1000") ;;
  *) fail "sandbox container ${SBX_NAME} is not non-root uid 1000 (Config.User='${SBX_USER}')" ;;
esac
[ "$SBX_ROROOTFS" = "true" ] ||
  fail "sandbox container ${SBX_NAME} rootfs is not read-only (HostConfig.ReadonlyRootfs='${SBX_ROROOTFS}')"
[ "$HOST_LINE" = "$SBX_HOSTNAME" ] ||
  fail "tool-result hostname '${HOST_LINE}' differs from sandbox hostname '${SBX_HOSTNAME}'"
echo "==> OK: runBash ran in sandbox container ${SBX_NAME} as uid ${UID_LINE} (non-root, read-only rootfs)"

# --- 6. teardown through Agent Protocol, polling exact names only -----------
validate_claims || fail "ownership changed immediately before Agent Protocol DELETE"
assert_expected_sandbox_set
run_bounded curl -fsS -X DELETE "${BASE}/threads/${TID}" -o /dev/null ||
  fail "DELETE /threads/${TID} failed"

gone=""
i=0
while [ "$i" -lt 60 ]; do
  poll_exact_sandbox_names || fail "sandbox ownership changed while polling Agent Protocol DELETE"
  if [ -z "$SBX_ID" ] && [ -z "$SBX_VOLUME_FINGERPRINT" ]; then
    SBX_ADOPTION_STATE="absent"
    gone=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ -n "$gone" ] ||
  fail "sandbox container/volume not torn down within 60s of DELETE (container=${SBX_ID:-absent} volume=${SBX_VOLUME_FINGERPRINT:+present})"

echo "==> OK: sandbox container + volume torn down after DELETE /threads/${TID}"
echo "sandbox-docker-e2e assertions PASSED"
