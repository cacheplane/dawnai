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
SMOKE_COMMAND_TIMEOUT_MILLISECONDS="${SMOKE_COMMAND_TIMEOUT_MILLISECONDS:-}"
SMOKE_COMMAND_KILL_GRACE_MILLISECONDS="${SMOKE_COMMAND_KILL_GRACE_MILLISECONDS:-}"
SMOKE_RUN_CURL_MAX_TIME_SECONDS="${SMOKE_RUN_CURL_MAX_TIME_SECONDS:-240}"
SMOKE_RUN_TIMEOUT_SECONDS="${SMOKE_RUN_TIMEOUT_SECONDS:-245}"
SMOKE_CREATE_RECONCILE_ATTEMPTS="${SMOKE_CREATE_RECONCILE_ATTEMPTS:-3}"
SMOKE_CREATE_RECONCILE_DELAY_SECONDS="${SMOKE_CREATE_RECONCILE_DELAY_SECONDS:-1}"
SMOKE_SANDBOX_DELETE_POLL_ATTEMPTS="${SMOKE_SANDBOX_DELETE_POLL_ATTEMPTS:-60}"
SMOKE_SUPERVISOR_CONTROL_POLL_ATTEMPTS="${SMOKE_SUPERVISOR_CONTROL_POLL_ATTEMPTS:-100}"
SMOKE_SUPERVISOR_CONTROL_POLL_SECONDS="${SMOKE_SUPERVISOR_CONTROL_POLL_SECONDS:-0.05}"
SMOKE_SUPERVISOR_KILL_POLL_ATTEMPTS="${SMOKE_SUPERVISOR_KILL_POLL_ATTEMPTS:-40}"
SMOKE_SUPERVISOR_REAP_POLL_ATTEMPTS="${SMOKE_SUPERVISOR_REAP_POLL_ATTEMPTS:-100}"
SMOKE_SUPERVISOR_RESPONSE_MARGIN_MILLISECONDS="${SMOKE_SUPERVISOR_RESPONSE_MARGIN_MILLISECONDS:-1000}"
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
if [ -z "$SMOKE_COMMAND_TIMEOUT_MILLISECONDS" ]; then
  SMOKE_COMMAND_TIMEOUT_MILLISECONDS=$((SMOKE_COMMAND_TIMEOUT_SECONDS * 1000))
fi
case "$SMOKE_COMMAND_TIMEOUT_MILLISECONDS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_COMMAND_TIMEOUT_MILLISECONDS must be a positive integer" >&2
    exit 1
    ;;
esac
if [ -z "$SMOKE_COMMAND_KILL_GRACE_MILLISECONDS" ]; then
  SMOKE_COMMAND_KILL_GRACE_MILLISECONDS=$((SMOKE_COMMAND_KILL_GRACE_SECONDS * 1000))
fi
case "$SMOKE_COMMAND_KILL_GRACE_MILLISECONDS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_COMMAND_KILL_GRACE_MILLISECONDS must be a positive integer" >&2
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
case "$SMOKE_CREATE_RECONCILE_ATTEMPTS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_CREATE_RECONCILE_ATTEMPTS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_CREATE_RECONCILE_DELAY_SECONDS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_CREATE_RECONCILE_DELAY_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_SANDBOX_DELETE_POLL_ATTEMPTS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_SANDBOX_DELETE_POLL_ATTEMPTS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_SUPERVISOR_CONTROL_POLL_ATTEMPTS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_SUPERVISOR_CONTROL_POLL_ATTEMPTS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_SUPERVISOR_CONTROL_POLL_SECONDS" in
  '' | *[!0-9.]* | *.*.* | 0 | 0.0 | 0.00)
    echo "ASSERT FAILED: SMOKE_SUPERVISOR_CONTROL_POLL_SECONDS must be a positive number" >&2
    exit 1
    ;;
esac
case "$SMOKE_SUPERVISOR_KILL_POLL_ATTEMPTS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_SUPERVISOR_KILL_POLL_ATTEMPTS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_SUPERVISOR_REAP_POLL_ATTEMPTS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_SUPERVISOR_REAP_POLL_ATTEMPTS must be a positive integer" >&2
    exit 1
    ;;
esac
case "$SMOKE_SUPERVISOR_RESPONSE_MARGIN_MILLISECONDS" in
  '' | *[!0-9]* | 0)
    echo "ASSERT FAILED: SMOKE_SUPERVISOR_RESPONSE_MARGIN_MILLISECONDS must be a positive integer" >&2
    exit 1
    ;;
esac

for REQUIRED_COMMAND in docker curl jq awk grep sed tr sleep cat mkdir mkfifo rm node; do
  command -v "$REQUIRED_COMMAND" >/dev/null 2>&1 || {
    echo "ASSERT FAILED: required command '${REQUIRED_COMMAND}' is unavailable" >&2
    exit 1
  }
done

# --- Bounded command execution ---------------------------------------------
# Noninteractive macOS sh and Linux dash cannot portably create and prove a
# private process group. One run-scoped Node supervisor therefore creates a
# fresh detached wrapper group for each sequential foreground CLI command.
umask 077
SMOKE_RUN_DIRECTORY=""
RB_CALL_SEQUENCE=0
RB_ACTIVE=0
RB_SERVER_LAUNCHER_PID=""
RB_SERVER_READY=0
RB_SERVER_FDS_OPEN=0
RB_REQUEST_FIFO=""
RB_RESPONSE_FIFO=""
RB_SERVER_READY_PATH=""
RB_SERVER_LAUNCHED_PATH=""
RB_SERVER_STOPPED_PATH=""
RB_SERVER_EXIT_PATH=""
RB_SIGNAL_REQUEST_PATH=""
RB_SIGNAL_NAME=""
RB_SIGNAL_STATUS=0
RB_TAB=$(printf '\t')
RUN_BOUNDED_OUTPUT=""
VALIDATION_CONTAINER_ROWS_READY=0
VALIDATION_CONTAINER_ROWS=""

case "$0" in
  */*) SMOKE_SCRIPT_DIRECTORY_PART=${0%/*} ;;
  *) SMOKE_SCRIPT_DIRECTORY_PART=. ;;
esac
SMOKE_SCRIPT_DIRECTORY=$(CDPATH='' cd -P "$SMOKE_SCRIPT_DIRECTORY_PART" 2>/dev/null && pwd) || {
  echo "ASSERT FAILED: could not resolve smoke script directory" >&2
  exit 1
}
RUN_BOUNDED_HELPER="${SMOKE_SCRIPT_DIRECTORY}/run-bounded.mjs"
[ -f "$RUN_BOUNDED_HELPER" ] || {
  echo "ASSERT FAILED: bounded-command helper '${RUN_BOUNDED_HELPER}' is unavailable" >&2
  exit 1
}

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

initialize_bounded_supervisor() {
  RB_REQUEST_FIFO="${SMOKE_RUN_DIRECTORY}/request.fifo"
  RB_RESPONSE_FIFO="${SMOKE_RUN_DIRECTORY}/response.fifo"
  RB_SERVER_READY_PATH="${SMOKE_RUN_DIRECTORY}/server-ready"
  RB_SERVER_LAUNCHED_PATH="${SMOKE_RUN_DIRECTORY}/server-launched"
  RB_SERVER_STOPPED_PATH="${SMOKE_RUN_DIRECTORY}/server-stopped"
  RB_SERVER_EXIT_PATH="${SMOKE_RUN_DIRECTORY}/server-exit"
  if ! mkfifo "$RB_REQUEST_FIFO" "$RB_RESPONSE_FIFO"; then
    echo "ASSERT FAILED: could not create bounded-supervisor FIFOs" >&2
    return 1
  fi

  # Dawn's CI/local harness targets Darwin and Linux, whose FIFO implementations
  # support read-write opens. Holding both ends before helper startup prevents a
  # blocking endpoint race and preserves READY if the helper exits after writing.
  if ! exec 8<>"$RB_REQUEST_FIFO"; then
    echo "ASSERT FAILED: could not open bounded-supervisor request FIFO" >&2
    return 1
  fi
  if ! exec 9<>"$RB_RESPONSE_FIFO"; then
    echo "ASSERT FAILED: could not open bounded-supervisor response FIFO" >&2
    exec 8>&-
    return 1
  fi
  RB_SERVER_FDS_OPEN=1

  (
    RB_LAUNCHED_SERVER_PID=""
    trap ':' HUP INT TERM
    trap '[ -z "$RB_LAUNCHED_SERVER_PID" ] || kill -TERM "$RB_LAUNCHED_SERVER_PID" 2>/dev/null || :' USR1
    trap '[ -z "$RB_LAUNCHED_SERVER_PID" ] || kill -KILL "$RB_LAUNCHED_SERVER_PID" 2>/dev/null || :' USR2
    node "$RUN_BOUNDED_HELPER" --server "$SMOKE_RUN_DIRECTORY" \
      "$RB_REQUEST_FIFO" "$RB_RESPONSE_FIFO" &
    RB_LAUNCHED_SERVER_PID=$!
    printf 'launched\n' >"$RB_SERVER_LAUNCHED_PATH"
    RB_LAUNCHED_SERVER_STATUS=0
    while kill -0 "$RB_LAUNCHED_SERVER_PID" 2>/dev/null; do
      if wait "$RB_LAUNCHED_SERVER_PID"; then
        RB_LAUNCHED_SERVER_STATUS=0
      else
        RB_LAUNCHED_SERVER_STATUS=$?
      fi
    done
    printf '%s\n' "$RB_LAUNCHED_SERVER_STATUS" >"$RB_SERVER_EXIT_PATH"
    exit "$RB_LAUNCHED_SERVER_STATUS"
  ) &
  RB_SERVER_LAUNCHER_PID=$!

  if ! wait_for_supervisor_marker "$RB_SERVER_LAUNCHED_PATH"; then
    echo "ASSERT FAILED: bounded supervisor did not publish its launch marker" >&2
    return 1
  fi

  if wait_for_supervisor_marker "$RB_SERVER_READY_PATH"; then :; else
    RB_READY_WAIT_STATUS=$?
    if [ "$RB_READY_WAIT_STATUS" = "2" ]; then
      echo "ASSERT FAILED: bounded supervisor exited before out-of-band READY" >&2
    else
      echo "ASSERT FAILED: bounded supervisor did not signal out-of-band READY before its deadline" >&2
    fi
    return 1
  fi

  if ! IFS= read -r RB_SERVER_RESPONSE <&9; then
    echo "ASSERT FAILED: bounded supervisor closed before READY" >&2
    return 1
  fi
  if [ "$RB_SERVER_RESPONSE" != "READY" ]; then
    echo "ASSERT FAILED: invalid bounded-supervisor READY response" >&2
    return 1
  fi
  RB_SERVER_READY=1
  return 0
}

wait_for_supervisor_marker() {
  RB_MARKER_PATH=$1
  RB_MARKER_ATTEMPT=0
  while [ "$RB_MARKER_ATTEMPT" -lt "$SMOKE_SUPERVISOR_CONTROL_POLL_ATTEMPTS" ]; do
    [ -s "$RB_MARKER_PATH" ] && return 0
    [ -s "$RB_SERVER_EXIT_PATH" ] && return 2
    /bin/sleep "$SMOKE_SUPERVISOR_CONTROL_POLL_SECONDS"
    RB_MARKER_ATTEMPT=$((RB_MARKER_ATTEMPT + 1))
  done
  [ -s "$RB_MARKER_PATH" ] && return 0
  [ -s "$RB_SERVER_EXIT_PATH" ] && return 2
  return 1
}

wait_for_supervisor_exit() {
  RB_EXIT_ATTEMPT=0
  while [ "$RB_EXIT_ATTEMPT" -lt "$1" ]; do
    [ -s "$RB_SERVER_EXIT_PATH" ] && return 0
    /bin/sleep "$SMOKE_SUPERVISOR_CONTROL_POLL_SECONDS"
    RB_EXIT_ATTEMPT=$((RB_EXIT_ATTEMPT + 1))
  done
  [ -s "$RB_SERVER_EXIT_PATH" ]
}

wait_for_bounded_response() {
  RB_RESPONSE_READY_PATH=$1
  RB_RESPONSE_REMAINING_MILLISECONDS=$2
  RB_RESPONSE_FAST_ATTEMPTS=100
  while [ "$RB_RESPONSE_REMAINING_MILLISECONDS" -gt 0 ]; do
    [ -s "$RB_RESPONSE_READY_PATH" ] && return 0
    [ -s "$RB_SERVER_EXIT_PATH" ] && return 2
    if [ "$RB_RESPONSE_FAST_ATTEMPTS" -gt 0 ]; then
      /bin/sleep 0.01
      RB_RESPONSE_FAST_ATTEMPTS=$((RB_RESPONSE_FAST_ATTEMPTS - 1))
      RB_RESPONSE_REMAINING_MILLISECONDS=$((RB_RESPONSE_REMAINING_MILLISECONDS - 10))
    else
      /bin/sleep 0.1
      RB_RESPONSE_REMAINING_MILLISECONDS=$((RB_RESPONSE_REMAINING_MILLISECONDS - 100))
    fi
  done
  [ -s "$RB_RESPONSE_READY_PATH" ] && return 0
  [ -s "$RB_SERVER_EXIT_PATH" ] && return 2
  return 1
}

close_bounded_supervisor_fds() {
  if [ "$RB_SERVER_FDS_OPEN" = "1" ]; then
    exec 8>&-
    exec 9<&-
    RB_SERVER_FDS_OPEN=0
  fi
}

terminate_bounded_supervisor() {
  if [ ! -s "$RB_SERVER_EXIT_PATH" ] && [ -n "$RB_SERVER_LAUNCHER_PID" ]; then
    kill -USR1 "$RB_SERVER_LAUNCHER_PID" 2>/dev/null || :
    if ! wait_for_supervisor_exit "$SMOKE_SUPERVISOR_KILL_POLL_ATTEMPTS"; then
      kill -USR2 "$RB_SERVER_LAUNCHER_PID" 2>/dev/null || :
      wait_for_supervisor_exit "$SMOKE_SUPERVISOR_REAP_POLL_ATTEMPTS" || :
    fi
  fi
  if [ ! -s "$RB_SERVER_EXIT_PATH" ] && [ -n "$RB_SERVER_LAUNCHER_PID" ]; then
    kill -KILL "$RB_SERVER_LAUNCHER_PID" 2>/dev/null || :
  fi
}

shutdown_bounded_supervisor() {
  RB_SHUTDOWN_STATUS=0
  if [ "$RB_SERVER_READY" = "1" ]; then
    if ! printf 'STOP\n' >&8; then
      echo "CLEANUP ERROR: could not request bounded-supervisor shutdown" >&2
      RB_SHUTDOWN_STATUS=1
    elif wait_for_supervisor_marker "$RB_SERVER_STOPPED_PATH"; then
      if ! IFS= read -r RB_SERVER_RESPONSE <&9; then
        echo "CLEANUP ERROR: bounded supervisor closed before in-band STOPPED" >&2
        RB_SHUTDOWN_STATUS=1
      elif [ "$RB_SERVER_RESPONSE" != "STOPPED" ]; then
        echo "CLEANUP ERROR: invalid bounded-supervisor STOPPED response" >&2
        RB_SHUTDOWN_STATUS=1
      fi
    else
      echo "CLEANUP ERROR: bounded supervisor did not stop before its shutdown deadline" >&2
      RB_SHUTDOWN_STATUS=1
    fi
  fi
  RB_SERVER_READY=0
  close_bounded_supervisor_fds

  if [ -n "$RB_SERVER_LAUNCHER_PID" ]; then
    if ! wait_for_supervisor_exit "$SMOKE_SUPERVISOR_KILL_POLL_ATTEMPTS"; then
      RB_SHUTDOWN_STATUS=1
      terminate_bounded_supervisor
    fi
    if wait "$RB_SERVER_LAUNCHER_PID"; then
      RB_SERVER_WAIT_STATUS=0
    else
      RB_SERVER_WAIT_STATUS=$?
    fi
    RB_SERVER_LAUNCHER_PID=""
    if [ "$RB_SERVER_WAIT_STATUS" != "0" ]; then
      echo "CLEANUP ERROR: bounded supervisor exited with status ${RB_SERVER_WAIT_STATUS}" >&2
      RB_SHUTDOWN_STATUS=1
    fi
  fi
  return "$RB_SHUTDOWN_STATUS"
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

handle_bounded_signal() {
  if [ -z "$RB_SIGNAL_NAME" ]; then
    RB_SIGNAL_NAME=$1
    RB_SIGNAL_STATUS=$2
  fi
  if [ "$RB_ACTIVE" = "1" ] && [ -n "$RB_SIGNAL_REQUEST_PATH" ]; then
    printf 'SIG%s\n' "$RB_SIGNAL_NAME" >"$RB_SIGNAL_REQUEST_PATH"
  fi
  return 0
}

run_bounded_internal() {
  RB_CAPTURE_MODE=$1
  RB_TIMEOUT_SECONDS=$2
  RB_TIMEOUT_MILLISECONDS=$3
  shift 3
  RB_COMMAND_LABEL=$*
  RUN_BOUNDED_OUTPUT=""
  if [ "$RB_SERVER_READY" != "1" ]; then
    echo "BOUNDED SUPERVISOR ERROR: server is unavailable for ${RB_COMMAND_LABEL}" >&2
    return 125
  fi

  RB_CALL_SEQUENCE=$((RB_CALL_SEQUENCE + 1))
  RB_CALL_DIRECTORY="${SMOKE_RUN_DIRECTORY}/call.${RB_CALL_SEQUENCE}"
  if ! mkdir "$RB_CALL_DIRECTORY"; then
    echo "BOUNDED SUPERVISOR ERROR: could not create call ${RB_CALL_SEQUENCE}" >&2
    return 125
  fi
  printf '%s\n' "$#" >"${RB_CALL_DIRECTORY}/argc"
  RB_ARGUMENT_INDEX=0
  for RB_ARGUMENT do
    printf '%s' "$RB_ARGUMENT" >"${RB_CALL_DIRECTORY}/arg.${RB_ARGUMENT_INDEX}"
    RB_ARGUMENT_INDEX=$((RB_ARGUMENT_INDEX + 1))
  done
  RB_SIGNAL_REQUEST_PATH="${RB_CALL_DIRECTORY}/signal-request"
  : >"$RB_SIGNAL_REQUEST_PATH"

  RB_ACTIVE=1
  RB_SIGNAL_NAME=""
  RB_SIGNAL_STATUS=0
  trap 'handle_bounded_signal HUP 129' HUP
  trap 'handle_bounded_signal INT 130' INT
  trap 'handle_bounded_signal TERM 143' TERM

  RB_REQUEST_SENT=0
  if printf 'RUN\t%s\t%s\t%s\n' "$RB_CALL_SEQUENCE" \
    "$RB_TIMEOUT_MILLISECONDS" "$SMOKE_COMMAND_KILL_GRACE_MILLISECONDS" >&8; then
    RB_REQUEST_SENT=1
  else
    echo "BOUNDED SUPERVISOR ERROR: request failed for ${RB_COMMAND_LABEL}" >&2
  fi

  RB_RESPONSE_MATCHED=0
  RB_COMMAND_STATUS=125
  if [ "$RB_REQUEST_SENT" = "1" ]; then
    RB_RESPONSE_READY_PATH="${RB_CALL_DIRECTORY}/response-ready"
    RB_RESPONSE_DEADLINE_MILLISECONDS=$((
      RB_TIMEOUT_MILLISECONDS +
        SMOKE_COMMAND_KILL_GRACE_MILLISECONDS +
        SMOKE_SUPERVISOR_RESPONSE_MARGIN_MILLISECONDS
    ))
    RB_RESPONSE_WAIT_STATUS=0
    wait_for_bounded_response "$RB_RESPONSE_READY_PATH" \
      "$RB_RESPONSE_DEADLINE_MILLISECONDS" || RB_RESPONSE_WAIT_STATUS=$?
    case "$RB_RESPONSE_WAIT_STATUS" in
      0) ;;
      2)
        echo "BOUNDED SUPERVISOR ERROR: server exited before responding to ${RB_COMMAND_LABEL}" >&2
        RB_REQUEST_SENT=0
        ;;
      *)
        echo "BOUNDED SUPERVISOR ERROR: response deadline expired for ${RB_COMMAND_LABEL}" >&2
        RB_REQUEST_SENT=0
        ;;
    esac
    if [ "$RB_REQUEST_SENT" != "1" ]; then
      RB_SERVER_READY=0
      terminate_bounded_supervisor
    fi
  fi
  if [ "$RB_REQUEST_SENT" = "1" ]; then
    RB_SERVER_RESPONSE=""
    if IFS= read -r RB_SERVER_RESPONSE <&9; then
      RB_EXPECTED_RESPONSE="RESULT${RB_TAB}${RB_CALL_SEQUENCE}${RB_TAB}"
      case "$RB_SERVER_RESPONSE" in
        "$RB_EXPECTED_RESPONSE"*)
          RB_COMMAND_STATUS=${RB_SERVER_RESPONSE#"$RB_EXPECTED_RESPONSE"}
          case "$RB_COMMAND_STATUS" in
            '' | *[!0-9]*)
              echo "BOUNDED SUPERVISOR ERROR: invalid result for ${RB_COMMAND_LABEL}" >&2
              RB_COMMAND_STATUS=125
              ;;
            *) RB_RESPONSE_MATCHED=1 ;;
          esac
          ;;
        *)
          echo "BOUNDED SUPERVISOR ERROR: unexpected response '${RB_SERVER_RESPONSE}'" >&2
          ;;
      esac
    fi
    if [ "$RB_RESPONSE_MATCHED" != "1" ]; then
      echo "BOUNDED SUPERVISOR ERROR: response FIFO closed for ${RB_COMMAND_LABEL}" >&2
    fi
  fi

  RB_ACTIVE=0
  restore_smoke_signal_traps

  if [ "$RB_RESPONSE_MATCHED" != "1" ]; then RB_SERVER_READY=0; fi
  if [ -s "${RB_CALL_DIRECTORY}/stdout" ]; then
    RUN_BOUNDED_OUTPUT=$(cat "${RB_CALL_DIRECTORY}/stdout")
  fi
  if [ -s "${RB_CALL_DIRECTORY}/stderr" ]; then
    cat "${RB_CALL_DIRECTORY}/stderr" >&2
  fi
  if [ "$RB_CAPTURE_MODE" = "replay" ] && [ -n "$RUN_BOUNDED_OUTPUT" ]; then
    printf '%s' "$RUN_BOUNDED_OUTPUT"
  fi
  if [ -s "${RB_CALL_DIRECTORY}/timeout" ]; then
    printf 'COMMAND TIMEOUT after %ss: %s; sending TERM\n' \
      "$RB_TIMEOUT_SECONDS" "$RB_COMMAND_LABEL" >&3
    printf 'COMMAND TIMEOUT grace expired after %ss: %s; sending KILL\n' \
      "$SMOKE_COMMAND_KILL_GRACE_SECONDS" "$RB_COMMAND_LABEL" >&3
  fi

  if [ -n "$RB_SIGNAL_NAME" ]; then
    SIGNAL_NAME=$RB_SIGNAL_NAME
    RB_FINAL_SIGNAL_STATUS=$RB_SIGNAL_STATUS
    RB_SIGNAL_NAME=""
    RB_SIGNAL_STATUS=0
    RB_SIGNAL_REQUEST_PATH=""
    exit "$RB_FINAL_SIGNAL_STATUS"
  fi
  RB_SIGNAL_REQUEST_PATH=""
  return "$RB_COMMAND_STATUS"
}

run_bounded_for() {
  RB_PUBLIC_TIMEOUT=$1
  shift
  run_bounded_internal replay "$RB_PUBLIC_TIMEOUT" "$((RB_PUBLIC_TIMEOUT * 1000))" "$@"
}

run_bounded() {
  run_bounded_internal replay "$SMOKE_COMMAND_TIMEOUT_SECONDS" \
    "$SMOKE_COMMAND_TIMEOUT_MILLISECONDS" "$@"
}

run_bounded_capture_for() {
  RB_PUBLIC_TIMEOUT=$1
  shift
  run_bounded_internal capture "$RB_PUBLIC_TIMEOUT" "$((RB_PUBLIC_TIMEOUT * 1000))" "$@"
}

run_bounded_capture() {
  run_bounded_internal capture "$SMOKE_COMMAND_TIMEOUT_SECONDS" \
    "$SMOKE_COMMAND_TIMEOUT_MILLISECONDS" "$@"
}

normalize_read_result() {
  READ_RESULT=$(printf '%s' "$RUN_BOUNDED_OUTPUT" | tr -d '\r\n')
}

read_container_id() {
  if run_bounded_capture docker inspect --format '{{.Id}}' "$1" 2>/dev/null; then
    normalize_read_result
  else
    return $?
  fi
}

read_network_id() {
  if run_bounded_capture docker network inspect --format '{{.Id}}' "$1" 2>/dev/null; then
    normalize_read_result
  else
    return $?
  fi
}

list_all_container_rows() {
  if run_bounded_capture docker ps -a --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null; then
    LIST_RESULT=$RUN_BOUNDED_OUTPUT
  else
    return $?
  fi
}

list_all_network_rows() {
  if run_bounded_capture docker network ls --no-trunc --format '{{.ID}} {{.Name}}' 2>/dev/null; then
    LIST_RESULT=$RUN_BOUNDED_OUTPUT
  else
    return $?
  fi
}

list_all_volume_rows() {
  if run_bounded_capture docker volume ls --format '{{.Name}}' 2>/dev/null; then
    LIST_RESULT=$RUN_BOUNDED_OUTPUT
  else
    return $?
  fi
}

list_exact_container_ids() {
  LIST_TARGET=$1
  list_all_container_rows || return $?
  LIST_ROWS=$LIST_RESULT
  LIST_RESULT=$(printf '%s\n' "$LIST_ROWS" |
    awk -v target="$LIST_TARGET" '{ sub(/\r$/, ""); if ($2 == target) print $1 }')
}

list_exact_network_ids() {
  LIST_TARGET=$1
  list_all_network_rows || return $?
  LIST_ROWS=$LIST_RESULT
  LIST_RESULT=$(printf '%s\n' "$LIST_ROWS" |
    awk -v target="$LIST_TARGET" '{ sub(/\r$/, ""); if ($2 == target) print $1 }')
}

list_exact_volume_names() {
  LIST_TARGET=$1
  list_all_volume_rows || return $?
  LIST_ROWS=$LIST_RESULT
  LIST_RESULT=$(printf '%s\n' "$LIST_ROWS" |
    awk -v target="$LIST_TARGET" '{ sub(/\r$/, ""); if ($1 == target) print $1 }')
}

read_container_format() {
  READ_FORMAT=$1
  READ_TARGET=$2
  if run_bounded_capture docker inspect --format "$READ_FORMAT" "$READ_TARGET" 2>/dev/null; then
    normalize_read_result
  else
    return $?
  fi
}

read_sandbox_thread_label() {
  read_container_format '{{ index .Config.Labels "dawn.sandbox" }}' "$1"
}

read_sandbox_identity_label() {
  read_container_format '{{ index .Config.Labels "dawn.sandbox.identity" }}' "$1"
}

read_container_run_label() {
  read_container_format '{{ index .Config.Labels "dawn.smoke.run" }}' "$1"
}

read_network_run_label() {
  if run_bounded_capture docker network inspect \
    --format '{{ index .Labels "dawn.smoke.run" }}' "$1" 2>/dev/null; then
    normalize_read_result
  else
    return $?
  fi
}

read_volume_fingerprint() {
  READ_VOLUME_NAME=$1
  run_bounded_capture docker volume inspect "$READ_VOLUME_NAME" 2>/dev/null || return $?
  READ_VOLUME_JSON=$RUN_BOUNDED_OUTPUT
  READ_RESULT=$(printf '%s' "$READ_VOLUME_JSON" |
    jq -cS '.[0] | {CreatedAt, Driver, Labels, Mountpoint, Name, Options, Scope}' |
    tr -d '\r\n') || return $?
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
THREAD_DELETE_ATTEMPTED=0

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
RUN_TOKEN=""

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

load_container_claim_rows() {
  CLAIM_EXPECTED_NAME=$1
  CLAIM_EXPECTED_ID=$2
  if [ "$VALIDATION_CONTAINER_ROWS_READY" = "1" ]; then
    CLAIM_ROWS=$VALIDATION_CONTAINER_ROWS
  else
    list_all_container_rows || return $?
    CLAIM_ROWS=$LIST_RESULT
  fi
  CLAIM_ID_NAMES=$(printf '%s\n' "$CLAIM_ROWS" |
    awk -v target="$CLAIM_EXPECTED_ID" '{ sub(/\r$/, ""); if ($1 == target) print $2 }')
  CLAIM_NAME_IDS=$(printf '%s\n' "$CLAIM_ROWS" |
    awk -v target="$CLAIM_EXPECTED_NAME" '{ sub(/\r$/, ""); if ($2 == target) print $1 }')
}

load_network_claim_rows() {
  CLAIM_EXPECTED_NAME=$1
  CLAIM_EXPECTED_ID=$2
  list_all_network_rows || return $?
  CLAIM_ROWS=$LIST_RESULT
  CLAIM_ID_NAMES=$(printf '%s\n' "$CLAIM_ROWS" |
    awk -v target="$CLAIM_EXPECTED_ID" '{ sub(/\r$/, ""); if ($1 == target) print $2 }')
  CLAIM_NAME_IDS=$(printf '%s\n' "$CLAIM_ROWS" |
    awk -v target="$CLAIM_EXPECTED_NAME" '{ sub(/\r$/, ""); if ($2 == target) print $1 }')
}

assert_exact_container_absent() {
  ABSENT_NAME=$1
  ABSENT_DESCRIPTION=$2
  if list_exact_container_ids "$ABSENT_NAME"; then
    ABSENT_IDS=$LIST_RESULT
  else
    fail "could not verify absence of ${ABSENT_DESCRIPTION} '${ABSENT_NAME}'"
  fi
  [ -z "$ABSENT_IDS" ] ||
    fail "${ABSENT_DESCRIPTION} '${ABSENT_NAME}' is occupied by container ${ABSENT_IDS}; refusing to continue"
}

assert_exact_network_absent() {
  ABSENT_NAME=$1
  if list_exact_network_ids "$ABSENT_NAME"; then
    ABSENT_IDS=$LIST_RESULT
  else
    fail "could not verify absence of network '${ABSENT_NAME}'"
  fi
  [ -z "$ABSENT_IDS" ] ||
    fail "network '${ABSENT_NAME}' is occupied by object ${ABSENT_IDS}; refusing to continue"
}

assert_exact_volume_absent() {
  ABSENT_NAME=$1
  if list_exact_volume_names "$ABSENT_NAME"; then
    ABSENT_NAMES=$LIST_RESULT
  else
    fail "could not verify absence of sandbox volume '${ABSENT_NAME}'"
  fi
  [ -z "$ABSENT_NAMES" ] ||
    fail "sandbox volume '${ABSENT_NAME}' is occupied; refusing to continue"
}

assert_no_sandbox_occupancy() {
  if run_bounded_capture docker ps -aq --no-trunc --filter "name=${SBX_PREFIX}" 2>/dev/null; then
    OCCUPIED_CONTAINERS=$RUN_BOUNDED_OUTPUT
  else
    fail "could not preflight ${SBX_PREFIX}* containers"
  fi
  if [ -n "$OCCUPIED_CONTAINERS" ]; then
    fail "a ${SBX_PREFIX}* sandbox container is occupied; refusing to continue"
  fi

  if run_bounded_capture docker volume ls -q --filter "name=${SBX_VOL_PREFIX}" 2>/dev/null; then
    OCCUPIED_VOLUMES=$RUN_BOUNDED_OUTPUT
  else
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
  ADOPTION_ATTEMPT=0
  while [ "$ADOPTION_ATTEMPT" -lt "$SMOKE_CREATE_RECONCILE_ATTEMPTS" ]; do
    if list_exact_network_ids "$NET"; then
      ADOPTED_FIXED_IDS=$LIST_RESULT
    else
      echo "CLEANUP OWNERSHIP ERROR: ambiguous network create could not be resolved" >&2
      reject_network_claim
      return 1
    fi
    ADOPTED_FIXED_COUNT=$(printf '%s\n' "$ADOPTED_FIXED_IDS" | grep -c . || true)
    if [ "$ADOPTED_FIXED_COUNT" = "1" ] && is_full_object_id "$ADOPTED_FIXED_IDS"; then
      if read_network_run_label "$ADOPTED_FIXED_IDS"; then
        ADOPTED_FIXED_LABEL=$READ_RESULT
        if [ "$ADOPTED_FIXED_LABEL" = "$RUN_TOKEN" ]; then
          NETWORK_ID=$ADOPTED_FIXED_IDS
          NETWORK_CREATE_STATE="claimed"
          return 0
        fi
        echo "CLEANUP OWNERSHIP ERROR: ambiguous network create has a foreign run token; preserving it" >&2
        reject_network_claim
        return 1
      fi
    elif [ "$ADOPTED_FIXED_COUNT" != "0" ]; then
      echo "CLEANUP OWNERSHIP ERROR: ambiguous network create returned an invalid exact-name identity" >&2
      reject_network_claim
      return 1
    fi
    ADOPTION_ATTEMPT=$((ADOPTION_ATTEMPT + 1))
    if [ "$ADOPTION_ATTEMPT" -lt "$SMOKE_CREATE_RECONCILE_ATTEMPTS" ]; then
      sleep "$SMOKE_CREATE_RECONCILE_DELAY_SECONDS"
    fi
  done
  echo "CLEANUP OWNERSHIP ERROR: ambiguous network create did not produce an attributable object" >&2
  reject_network_claim
  return 1
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
  ADOPTION_ATTEMPT=0
  while [ "$ADOPTION_ATTEMPT" -lt "$SMOKE_CREATE_RECONCILE_ATTEMPTS" ]; do
    if list_exact_container_ids "$AIMOCK_NAME"; then
      ADOPTED_FIXED_IDS=$LIST_RESULT
    else
      echo "CLEANUP OWNERSHIP ERROR: ambiguous aimock create could not be resolved" >&2
      reject_aimock_claim
      return 1
    fi
    ADOPTED_FIXED_COUNT=$(printf '%s\n' "$ADOPTED_FIXED_IDS" | grep -c . || true)
    if [ "$ADOPTED_FIXED_COUNT" = "1" ] && is_full_object_id "$ADOPTED_FIXED_IDS"; then
      if read_container_run_label "$ADOPTED_FIXED_IDS"; then
        ADOPTED_FIXED_LABEL=$READ_RESULT
        if [ "$ADOPTED_FIXED_LABEL" = "$RUN_TOKEN" ]; then
          AIMOCK_ID=$ADOPTED_FIXED_IDS
          AIMOCK_CREATE_STATE="claimed"
          return 0
        fi
        echo "CLEANUP OWNERSHIP ERROR: ambiguous aimock create has a foreign run token; preserving it" >&2
        reject_aimock_claim
        return 1
      fi
    elif [ "$ADOPTED_FIXED_COUNT" != "0" ]; then
      echo "CLEANUP OWNERSHIP ERROR: ambiguous aimock create returned an invalid exact-name identity" >&2
      reject_aimock_claim
      return 1
    fi
    ADOPTION_ATTEMPT=$((ADOPTION_ATTEMPT + 1))
    if [ "$ADOPTION_ATTEMPT" -lt "$SMOKE_CREATE_RECONCILE_ATTEMPTS" ]; then
      sleep "$SMOKE_CREATE_RECONCILE_DELAY_SECONDS"
    fi
  done
  echo "CLEANUP OWNERSHIP ERROR: ambiguous aimock create did not produce an attributable object" >&2
  reject_aimock_claim
  return 1
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
  ADOPTION_ATTEMPT=0
  while [ "$ADOPTION_ATTEMPT" -lt "$SMOKE_CREATE_RECONCILE_ATTEMPTS" ]; do
    if list_exact_container_ids "$APP_NAME"; then
      ADOPTED_FIXED_IDS=$LIST_RESULT
    else
      echo "CLEANUP OWNERSHIP ERROR: ambiguous app create could not be resolved" >&2
      reject_app_claim
      return 1
    fi
    ADOPTED_FIXED_COUNT=$(printf '%s\n' "$ADOPTED_FIXED_IDS" | grep -c . || true)
    if [ "$ADOPTED_FIXED_COUNT" = "1" ] && is_full_object_id "$ADOPTED_FIXED_IDS"; then
      if read_container_run_label "$ADOPTED_FIXED_IDS"; then
        ADOPTED_FIXED_LABEL=$READ_RESULT
        if [ "$ADOPTED_FIXED_LABEL" = "$RUN_TOKEN" ]; then
          APP_ID=$ADOPTED_FIXED_IDS
          APP_CREATE_STATE="claimed"
          return 0
        fi
        echo "CLEANUP OWNERSHIP ERROR: ambiguous app create has a foreign run token; preserving it" >&2
        reject_app_claim
        return 1
      fi
    elif [ "$ADOPTED_FIXED_COUNT" != "0" ]; then
      echo "CLEANUP OWNERSHIP ERROR: ambiguous app create returned an invalid exact-name identity" >&2
      reject_app_claim
      return 1
    fi
    ADOPTION_ATTEMPT=$((ADOPTION_ATTEMPT + 1))
    if [ "$ADOPTION_ATTEMPT" -lt "$SMOKE_CREATE_RECONCILE_ATTEMPTS" ]; then
      sleep "$SMOKE_CREATE_RECONCILE_DELAY_SECONDS"
    fi
  done
  echo "CLEANUP OWNERSHIP ERROR: ambiguous app create did not produce an attributable object" >&2
  reject_app_claim
  return 1
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
      if list_exact_container_ids "$SBX_NAME"; then
        ADOPTED_IDS=$LIST_RESULT
      else
        echo "CLEANUP OWNERSHIP ERROR: final sandbox container listing failed" >&2
        return 1
      fi
      ADOPTED_COUNT=$(printf '%s\n' "$ADOPTED_IDS" | grep -c . || true)
      if [ "$ADOPTED_COUNT" = "0" ]; then
        if list_exact_volume_names "$SBX_VOLUME_NAME"; then
          ADOPTED_VOLUME_NAMES=$LIST_RESULT
        else
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
    else
      if read_container_id "$SBX_NAME"; then
        ADOPTED_ID=$READ_RESULT
      else
        echo "CLEANUP OWNERSHIP ERROR: expected sandbox container '${SBX_NAME}' was not observed after run start" >&2
        return 1
      fi
    fi

    if read_sandbox_thread_label "$ADOPTED_ID"; then
      ADOPTED_THREAD_LABEL=$READ_RESULT
    else
      echo "CLEANUP OWNERSHIP ERROR: could not read dawn.sandbox label from ${ADOPTED_ID}" >&2
      return 1
    fi
    if [ "$ADOPTED_THREAD_LABEL" != "$SANITIZED_TID" ]; then
      echo "CLEANUP OWNERSHIP ERROR: sandbox label '${ADOPTED_THREAD_LABEL}' does not equal '${SANITIZED_TID}'" >&2
      reject_sandbox_claims
      return 1
    fi
    if read_sandbox_identity_label "$ADOPTED_ID"; then
      ADOPTED_IDENTITY=$READ_RESULT
    else
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
    if list_exact_volume_names "$SBX_VOLUME_NAME"; then
      ADOPTED_VOLUME_NAMES=$LIST_RESULT
    else
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
  if read_volume_fingerprint "$SBX_VOLUME_NAME"; then
    SBX_VOLUME_FINGERPRINT=$READ_RESULT
    SBX_ADOPTION_STATE="adopted"
  else
    echo "CLEANUP OWNERSHIP ERROR: expected sandbox volume '${SBX_VOLUME_NAME}' was not observed after run start" >&2
    return 1
  fi
}

validate_app_claim() {
  [ -n "$APP_ID" ] || return 0
  VALIDATED_ID=$APP_ID
  if load_container_claim_rows "$APP_NAME" "$VALIDATED_ID"; then
    LIVE_ID_NAMES=$CLAIM_ID_NAMES
    LIVE_NAME_IDS=$CLAIM_NAME_IDS
  else
    echo "CLEANUP OWNERSHIP ERROR: app container ownership listing failed" >&2
    reject_app_claim
    return 1
  fi
  if [ -z "$LIVE_ID_NAMES" ]; then
    APP_ID=""
    if [ -n "$LIVE_NAME_IDS" ]; then
      APP_CREATE_STATE="rejected"
      echo "CLEANUP OWNERSHIP ERROR: app container '${APP_NAME}' changed from ${VALIDATED_ID} to ${LIVE_NAME_IDS}; skipping replacement" >&2
      return 1
    fi
    APP_CREATE_STATE="absent"
    APP_QUIESCED=1
    echo "CLEANUP OWNERSHIP ERROR: owned app container ${VALIDATED_ID} disappeared before cleanup" >&2
    return 1
  fi
  if [ "$LIVE_ID_NAMES" = "$APP_NAME" ] && [ "$LIVE_NAME_IDS" = "$VALIDATED_ID" ]; then
    return 0
  fi
  APP_CREATE_STATE="rejected"
  echo "CLEANUP OWNERSHIP ERROR: owned app container ${VALIDATED_ID} was renamed to '${LIVE_ID_NAMES:-unknown}' or '${APP_NAME}' was replaced by '${LIVE_NAME_IDS:-none}'" >&2
  return 1
}

validate_aimock_claim() {
  [ -n "$AIMOCK_ID" ] || return 0
  VALIDATED_ID=$AIMOCK_ID
  if load_container_claim_rows "$AIMOCK_NAME" "$VALIDATED_ID"; then
    LIVE_ID_NAMES=$CLAIM_ID_NAMES
    LIVE_NAME_IDS=$CLAIM_NAME_IDS
  else
    echo "CLEANUP OWNERSHIP ERROR: aimock container ownership listing failed" >&2
    reject_aimock_claim
    return 1
  fi
  if [ -z "$LIVE_ID_NAMES" ]; then
    AIMOCK_ID=""
    if [ -n "$LIVE_NAME_IDS" ]; then
      AIMOCK_CREATE_STATE="rejected"
      echo "CLEANUP OWNERSHIP ERROR: aimock container '${AIMOCK_NAME}' changed from ${VALIDATED_ID} to ${LIVE_NAME_IDS}; skipping replacement" >&2
      return 1
    fi
    AIMOCK_CREATE_STATE="absent"
    echo "CLEANUP OWNERSHIP ERROR: owned aimock container ${VALIDATED_ID} disappeared before cleanup" >&2
    return 1
  fi
  if [ "$LIVE_ID_NAMES" = "$AIMOCK_NAME" ] && [ "$LIVE_NAME_IDS" = "$VALIDATED_ID" ]; then
    return 0
  fi
  AIMOCK_CREATE_STATE="rejected"
  echo "CLEANUP OWNERSHIP ERROR: owned aimock container ${VALIDATED_ID} was renamed to '${LIVE_ID_NAMES:-unknown}' or '${AIMOCK_NAME}' was replaced by '${LIVE_NAME_IDS:-none}'" >&2
  return 1
}

validate_network_claim() {
  [ -n "$NETWORK_ID" ] || return 0
  VALIDATED_ID=$NETWORK_ID
  if load_network_claim_rows "$NET" "$VALIDATED_ID"; then
    LIVE_ID_NAMES=$CLAIM_ID_NAMES
    LIVE_NAME_IDS=$CLAIM_NAME_IDS
  else
    echo "CLEANUP OWNERSHIP ERROR: network ownership listing failed" >&2
    reject_network_claim
    return 1
  fi
  if [ -z "$LIVE_ID_NAMES" ]; then
    NETWORK_ID=""
    if [ -n "$LIVE_NAME_IDS" ]; then
      NETWORK_CREATE_STATE="rejected"
      echo "CLEANUP OWNERSHIP ERROR: network '${NET}' changed from ${VALIDATED_ID} to ${LIVE_NAME_IDS}; skipping replacement" >&2
      return 1
    fi
    NETWORK_CREATE_STATE="absent"
    echo "CLEANUP OWNERSHIP ERROR: owned network ${VALIDATED_ID} disappeared before cleanup" >&2
    return 1
  fi
  if [ "$LIVE_ID_NAMES" = "$NET" ] && [ "$LIVE_NAME_IDS" = "$VALIDATED_ID" ]; then return 0; fi
  NETWORK_CREATE_STATE="rejected"
  echo "CLEANUP OWNERSHIP ERROR: owned network ${VALIDATED_ID} was renamed to '${LIVE_ID_NAMES:-unknown}' or '${NET}' was replaced by '${LIVE_NAME_IDS:-none}'" >&2
  return 1
}

validate_sandbox_claim() {
  [ -n "$SBX_ID" ] || return 0
  if [ "$VALIDATION_CONTAINER_ROWS_READY" = "1" ]; then
    LIVE_IDS=$(printf '%s\n' "$VALIDATION_CONTAINER_ROWS" |
      awk -v target="$SBX_NAME" '{ sub(/\r$/, ""); if ($2 == target) print $1 }')
  elif list_exact_container_ids "$SBX_NAME"; then
    LIVE_IDS=$LIST_RESULT
  else
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
  if read_sandbox_thread_label "$SBX_ID"; then
    LIVE_THREAD_LABEL=$READ_RESULT
  else
    echo "CLEANUP OWNERSHIP ERROR: sandbox thread label could not be revalidated; invalidating container and volume claims" >&2
    reject_sandbox_claims
    return 1
  fi
  if read_sandbox_identity_label "$SBX_ID"; then
    LIVE_IDENTITY=$READ_RESULT
  else
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
  if list_exact_volume_names "$SBX_VOLUME_NAME"; then
    LIVE_NAMES=$LIST_RESULT
  else
    reject_sandbox_claims
    echo "CLEANUP OWNERSHIP ERROR: sandbox volume ownership listing failed" >&2
    return 1
  fi
  if [ -z "$LIVE_NAMES" ]; then
    SBX_VOLUME_FINGERPRINT=""
    return 0
  fi
  if [ "$LIVE_NAMES" != "$SBX_VOLUME_NAME" ]; then
    reject_sandbox_claims
    echo "CLEANUP OWNERSHIP ERROR: exact sandbox volume listing changed; skipping replacement" >&2
    return 1
  fi
  if read_volume_fingerprint "$SBX_VOLUME_NAME"; then
    LIVE_FINGERPRINT=$READ_RESULT
    if [ "$LIVE_FINGERPRINT" = "$SBX_VOLUME_FINGERPRINT" ]; then return 0; fi
    echo "CLEANUP OWNERSHIP ERROR: sandbox volume fingerprint changed; skipping replacement" >&2
    reject_sandbox_claims
    return 1
  fi
  reject_sandbox_claims
  echo "CLEANUP OWNERSHIP ERROR: sandbox volume fingerprint could not be revalidated" >&2
  return 1
}

validate_claims() {
  VALIDATION_RESULT=0
  VALIDATION_CONTAINER_ROWS_READY=0
  if list_all_container_rows; then
    VALIDATION_CONTAINER_ROWS=$LIST_RESULT
    VALIDATION_CONTAINER_ROWS_READY=1
    validate_app_claim || VALIDATION_RESULT=1
    validate_aimock_claim || VALIDATION_RESULT=1
    validate_sandbox_claim || VALIDATION_RESULT=1
  else
    echo "CLEANUP OWNERSHIP ERROR: fixed and sandbox container ownership listing failed" >&2
    reject_app_claim
    reject_aimock_claim
    reject_sandbox_claims
    VALIDATION_RESULT=1
  fi
  VALIDATION_CONTAINER_ROWS_READY=0
  VALIDATION_CONTAINER_ROWS=""
  validate_network_claim || VALIDATION_RESULT=1
  validate_volume_claim || VALIDATION_RESULT=1
  return "$VALIDATION_RESULT"
}

collect_diagnostics() {
  DIAGNOSTIC_STATUS=$1
  echo "----- diagnostics status=${DIAGNOSTIC_STATUS} signal=${SIGNAL_NAME} -----" >&2
  echo "----- sandbox container prefix entries (max 50, read-only) -----" >&2
  if run_bounded_capture docker ps -a --filter "name=${SBX_PREFIX}" \
    --format '{{.ID}} {{.Names}}' 2>&1; then
    printf '%s\n' "$RUN_BOUNDED_OUTPUT" | sed -n '1,50p' >&2
  fi
  echo "----- sandbox volume prefix entries (max 50, read-only) -----" >&2
  if run_bounded_capture docker volume ls -q --filter "name=${SBX_VOL_PREFIX}" 2>&1; then
    printf '%s\n' "$RUN_BOUNDED_OUTPUT" | sed -n '1,50p' >&2
  fi
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
  if list_all_container_rows; then
    QUIESCE_ROWS=$LIST_RESULT
  else
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
  if [ "$RUN_STARTED" = "1" ]; then
    if adopt_sandbox_claims final; then
      if [ -n "$APP_ID" ] && [ "$APP_CREATE_STATE" = "claimed" ] && [ "$APP_QUIESCED" != "1" ]; then
        cleanup_sandbox_through_provider || CLEANUP_RESULT=1
      else
        echo "CLEANUP OWNERSHIP ERROR: live owned app could not be proved; preserving sandbox resources" >&2
        CLEANUP_RESULT=1
      fi
    else
      CLEANUP_RESULT=1
    fi
  fi

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

  if [ "$RUN_STARTED" = "1" ]; then adopt_sandbox_claims final || CLEANUP_RESULT=1; fi

  if [ -n "$AIMOCK_ID" ]; then
    if remove_container_claim "$AIMOCK_ID" "aimock container"; then
      AIMOCK_CREATE_STATE="absent"
    else
      reject_aimock_claim
      CLEANUP_RESULT=1
    fi
    AIMOCK_ID=""
  fi
  if [ -n "$SBX_ID" ]; then
    if remove_container_claim "$SBX_ID" "sandbox container"; then
      SBX_ID=""
      SBX_THREAD_LABEL=""
      SBX_IDENTITY_LABEL=""
    else
      CLEANUP_RESULT=1
    fi
  fi
  if [ -n "$SBX_VOLUME_FINGERPRINT" ]; then
    echo "CLEANUP ERROR: claimed sandbox volume '${SBX_VOLUME_NAME}' remains after Agent Protocol DELETE; preserving it" >&2
    CLEANUP_RESULT=1
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
    cat "$DIAGNOSTIC_SNAPSHOT_PATH" >&2
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

  DIAGNOSTIC_SNAPSHOT_PATH="${SMOKE_RUN_DIRECTORY}/diagnostics"
  if collect_diagnostics "$ORIGINAL_STATUS" >"$DIAGNOSTIC_SNAPSHOT_PATH" 2>&1 3>&1; then :; else
    {
      echo "----- diagnostics status=${ORIGINAL_STATUS} signal=${SIGNAL_NAME} -----"
      echo "DIAGNOSTIC ERROR: pre-cleanup snapshot could not be captured"
    } >"$DIAGNOSTIC_SNAPSHOT_PATH"
  fi

  if [ "$ORIGINAL_STATUS" != "0" ] || [ "$EXIT_VALIDATION_FAILED" != "0" ]; then
    emit_diagnostic_snapshot
  fi

  validate_claims || EXIT_VALIDATION_FAILED=1
  if [ "$EXIT_VALIDATION_FAILED" != "0" ]; then emit_diagnostic_snapshot; fi
  cleanup_owned || EXIT_CLEANUP_FAILED=1
  if [ "$EXIT_CLEANUP_FAILED" != "0" ]; then emit_diagnostic_snapshot; fi
  shutdown_bounded_supervisor || EXIT_CLEANUP_FAILED=1
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
initialize_bounded_supervisor || fail "could not start bounded-command supervisor"

if run_bounded_capture node -e \
  'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))'; then
  RUN_TOKEN=$RUN_BOUNDED_OUTPUT
else
  fail "could not generate a collision-resistant smoke run token"
fi
case "$RUN_TOKEN" in
  '' | *[!0-9a-f]*) fail "generated smoke run token was invalid" ;;
esac

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
  if list_exact_container_ids "$SBX_NAME"; then
    EXACT_OBSERVED_IDS=$LIST_RESULT
  else
    fail "could not query exact sandbox container after runs/wait"
  fi
  EXACT_OBSERVED_COUNT=$(printf '%s\n' "$EXACT_OBSERVED_IDS" | grep -c . || true)
  if [ "$EXACT_OBSERVED_COUNT" != "1" ] || [ "$EXACT_OBSERVED_IDS" != "$SBX_ID" ]; then
    fail "exact sandbox container identity changed after runs/wait (count=${EXACT_OBSERVED_COUNT})"
  fi

  if run_bounded_capture docker ps -aq --no-trunc --filter "name=${SBX_PREFIX}" 2>/dev/null; then
    OBSERVED_IDS=$RUN_BOUNDED_OUTPUT
  else
    fail "could not list sandbox containers after runs/wait"
  fi
  OBSERVED_COUNT=$(printf '%s\n' "$OBSERVED_IDS" | grep -c . || true)
  if [ "$OBSERVED_COUNT" != "1" ] || [ "$OBSERVED_IDS" != "$SBX_ID" ]; then
    fail "unexpected concurrent sandbox container set after runs/wait (count=${OBSERVED_COUNT})"
  fi

  if run_bounded_capture docker volume ls -q --filter "name=${SBX_VOL_PREFIX}" 2>/dev/null; then
    OBSERVED_VOLUMES=$RUN_BOUNDED_OUTPUT
  else
    fail "could not list sandbox volumes after runs/wait"
  fi
  OBSERVED_VOLUME_COUNT=$(printf '%s\n' "$OBSERVED_VOLUMES" | grep -c . || true)
  if [ "$OBSERVED_VOLUME_COUNT" != "1" ] || [ "$OBSERVED_VOLUMES" != "$SBX_VOLUME_NAME" ]; then
    fail "unexpected concurrent sandbox volume set after runs/wait (count=${OBSERVED_VOLUME_COUNT})"
  fi
}

poll_exact_sandbox_names() {
  if [ -n "$SBX_ID" ]; then
    if list_exact_container_ids "$SBX_NAME"; then
      POLL_IDS=$LIST_RESULT
    else
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
      if read_sandbox_thread_label "$SBX_ID"; then
        POLL_THREAD=$READ_RESULT
      else
        echo "CLEANUP OWNERSHIP ERROR: sandbox labels changed after Agent Protocol DELETE" >&2
        invalidate_sandbox_claims
        return 1
      fi
      if read_sandbox_identity_label "$SBX_ID"; then
        POLL_IDENTITY=$READ_RESULT
      else
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
    if list_exact_volume_names "$SBX_VOLUME_NAME"; then
      POLL_NAMES=$LIST_RESULT
    else
      echo "CLEANUP OWNERSHIP ERROR: sandbox volume absence listing failed after Agent Protocol DELETE" >&2
      reject_sandbox_claims
      return 1
    fi
    if [ -n "$POLL_NAMES" ]; then
      if [ "$POLL_NAMES" != "$SBX_VOLUME_NAME" ]; then
        echo "CLEANUP OWNERSHIP ERROR: exact sandbox volume listing changed after Agent Protocol DELETE" >&2
        reject_sandbox_claims
        return 1
      fi
      if read_volume_fingerprint "$SBX_VOLUME_NAME"; then
        POLL_FINGERPRINT=$READ_RESULT
      else
        echo "CLEANUP OWNERSHIP ERROR: sandbox volume fingerprint read failed after Agent Protocol DELETE" >&2
        reject_sandbox_claims
        return 1
      fi
      if [ "$POLL_FINGERPRINT" != "$SBX_VOLUME_FINGERPRINT" ]; then
        echo "CLEANUP OWNERSHIP ERROR: sandbox volume changed after Agent Protocol DELETE" >&2
        reject_sandbox_claims
        return 1
      fi
    else
      SBX_VOLUME_FINGERPRINT=""
    fi
  fi
}

cleanup_sandbox_through_provider() {
  if [ "$THREAD_DELETE_ATTEMPTED" = "1" ]; then
    [ -z "$SBX_ID" ] && [ -z "$SBX_VOLUME_FINGERPRINT" ]
    return $?
  fi
  case "$SBX_ADOPTION_STATE" in
    adopted | absent) ;;
    *)
      echo "CLEANUP OWNERSHIP ERROR: sandbox ownership is not safe for Agent Protocol DELETE" >&2
      return 1
      ;;
  esac

  THREAD_DELETE_ATTEMPTED=1
  if ! run_bounded curl -fsS -X DELETE "${BASE}/threads/${TID}" -o /dev/null; then
    echo "CLEANUP ERROR: DELETE /threads/${TID} failed; preserving sandbox resources" >&2
    return 1
  fi

  PROVIDER_GONE=""
  PROVIDER_POLL_ATTEMPT=0
  while [ "$PROVIDER_POLL_ATTEMPT" -lt "$SMOKE_SANDBOX_DELETE_POLL_ATTEMPTS" ]; do
    poll_exact_sandbox_names || return 1
    if [ -z "$SBX_ID" ] && [ -z "$SBX_VOLUME_FINGERPRINT" ]; then
      SBX_ADOPTION_STATE="absent"
      PROVIDER_GONE=1
      break
    fi
    PROVIDER_POLL_ATTEMPT=$((PROVIDER_POLL_ATTEMPT + 1))
    sleep 1
  done
  if [ -z "$PROVIDER_GONE" ]; then
    echo "CLEANUP ERROR: sandbox container/volume remains after DELETE /threads/${TID}; preserving any volume" >&2
    return 1
  fi
  return 0
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

if run_bounded_capture docker run --rm -v "${DOCKER_SOCK}:/var/run/docker.sock" \
  --entrypoint sh "$APP_IMAGE" -c 'stat -c %g /var/run/docker.sock 2>/dev/null'; then
  SOCK_GID_RAW=$RUN_BOUNDED_OUTPUT
else
  fail "could not probe the docker socket group gid (is ${DOCKER_SOCK} mountable?)"
fi
SOCK_GID=$(printf '%s' "$SOCK_GID_RAW" | tr -dc '0-9')
[ -n "$SOCK_GID" ] || fail "could not probe the docker socket group gid (is ${DOCKER_SOCK} mountable?)"
echo "==> docker socket group gid = ${SOCK_GID}"

# --- 1. create fixed resources and capture exact IDs ------------------------
NETWORK_CREATE_STATE="pending"
NETWORK_CREATE_STATUS=0
CREATED_NETWORK_ID=""
if run_bounded_capture docker network create --label "dawn.smoke.run=${RUN_TOKEN}" "$NET" \
  2>/dev/null; then :; else
  NETWORK_CREATE_STATUS=$?
fi
CREATED_NETWORK_ID=$RUN_BOUNDED_OUTPUT
if is_full_object_id "$CREATED_NETWORK_ID"; then
  NETWORK_ID=$CREATED_NETWORK_ID NETWORK_CREATE_STATE="claimed"
fi
[ "$NETWORK_CREATE_STATE" != "pending" ] || adopt_ambiguous_network_claim || :
[ "$NETWORK_CREATE_STATUS" = "0" ] || fail "failed to create network ${NET}"
[ -n "$NETWORK_ID" ] || fail "network create did not return a valid immutable ID"
if read_network_id "$NET"; then
  REVALIDATED_NETWORK_ID=$READ_RESULT
else
  fail "failed to capture exact network ID after creating ${NET}"
fi
[ "$REVALIDATED_NETWORK_ID" = "$NETWORK_ID" ] || {
  validate_network_claim || :
  fail "network ownership changed between creation and identity capture; refusing replacement"
}
if read_network_run_label "$NETWORK_ID"; then
  REVALIDATED_RUN_LABEL=$READ_RESULT
else
  fail "failed to capture network run token after creating ${NET}"
fi
[ "$REVALIDATED_RUN_LABEL" = "$RUN_TOKEN" ] || {
  NETWORK_CREATE_STATE="rejected"
  fail "network run token changed after creation"
}
echo "==> network ${NET} ready (${NETWORK_ID})"

AIMOCK_CREATE_STATE="pending"
AIMOCK_CREATE_STATUS=0
CREATED_AIMOCK_ID=""
if run_bounded_capture docker run -d --label "dawn.smoke.run=${RUN_TOKEN}" \
  --name "$AIMOCK_NAME" --network "$NET" "$AIMOCK_IMAGE"; then :; else
  AIMOCK_CREATE_STATUS=$?
fi
CREATED_AIMOCK_ID=$RUN_BOUNDED_OUTPUT
if is_full_object_id "$CREATED_AIMOCK_ID"; then
  AIMOCK_ID=$CREATED_AIMOCK_ID AIMOCK_CREATE_STATE="claimed"
fi
[ "$AIMOCK_CREATE_STATE" != "pending" ] || adopt_ambiguous_aimock_claim || :
[ "$AIMOCK_CREATE_STATUS" = "0" ] || fail "failed to start aimock container"
[ -n "$AIMOCK_ID" ] || fail "aimock create did not return a valid immutable ID"
if read_container_id "$AIMOCK_NAME"; then
  REVALIDATED_AIMOCK_ID=$READ_RESULT
else
  fail "failed to capture exact aimock container ID"
fi
[ "$REVALIDATED_AIMOCK_ID" = "$AIMOCK_ID" ] || {
  validate_aimock_claim || :
  fail "aimock ownership changed between creation and identity capture; refusing replacement"
}
if read_container_run_label "$AIMOCK_ID"; then
  REVALIDATED_RUN_LABEL=$READ_RESULT
else
  fail "failed to capture aimock run token"
fi
[ "$REVALIDATED_RUN_LABEL" = "$RUN_TOKEN" ] || {
  AIMOCK_CREATE_STATE="rejected"
  fail "aimock run token changed after creation"
}
echo "==> aimock ${AIMOCK_NAME} started (${AIMOCK_ID})"

APP_CREATE_STATE="pending"
APP_REMOVAL_REQUIRED=1
APP_CREATE_STATUS=0
CREATED_APP_ID=""
if run_bounded_capture docker run -d --label "dawn.smoke.run=${RUN_TOKEN}" \
    --name "$APP_NAME" --network "$NET" \
    -v "${DOCKER_SOCK}:/var/run/docker.sock" \
    --group-add "$SOCK_GID" \
    -e DAWN_SMOKE_SANDBOX=docker \
    -e DAWN_PERMISSIONS_MODE=bypass \
    -e "OPENAI_BASE_URL=http://${AIMOCK_NAME}:${AIMOCK_PORT}/v1" \
    -e OPENAI_API_KEY=dummy \
    -p "${APP_PORT}:8000" \
    "$APP_IMAGE"
then :; else
  APP_CREATE_STATUS=$?
fi
CREATED_APP_ID=$RUN_BOUNDED_OUTPUT
if is_full_object_id "$CREATED_APP_ID"; then
  APP_ID=$CREATED_APP_ID APP_CREATE_STATE="claimed"
fi
[ "$APP_CREATE_STATE" != "pending" ] || adopt_ambiguous_app_claim || :
[ "$APP_CREATE_STATUS" = "0" ] || fail "failed to start app container"
[ -n "$APP_ID" ] || fail "app create did not return a valid immutable ID"
if read_container_id "$APP_NAME"; then
  REVALIDATED_APP_ID=$READ_RESULT
else
  fail "failed to capture exact app container ID"
fi
[ "$REVALIDATED_APP_ID" = "$APP_ID" ] || {
  validate_app_claim || :
  fail "app ownership changed between creation and identity capture; refusing replacement"
}
if read_container_run_label "$APP_ID"; then
  REVALIDATED_RUN_LABEL=$READ_RESULT
else
  fail "failed to capture app run token"
fi
[ "$REVALIDATED_RUN_LABEL" = "$RUN_TOKEN" ] || {
  APP_CREATE_STATE="rejected"
  fail "app run token changed after creation"
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
  if read_container_id "$APP_NAME"; then
    LIVE_APP_ID=$READ_RESULT
    if [ "$LIVE_APP_ID" != "$APP_ID" ]; then
      validate_app_claim || :
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
if run_bounded_capture curl -fsS -X POST "${BASE}/threads" \
  -H 'content-type: application/json' -d '{}'; then
  THREAD_JSON=$RUN_BOUNDED_OUTPUT
else
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
if run_bounded_capture_for "$SMOKE_RUN_TIMEOUT_SECONDS" \
    curl -fsS --max-time "$SMOKE_RUN_CURL_MAX_TIME_SECONDS" \
    -X POST "${BASE}/threads/${TID}/runs/wait" \
    -H 'content-type: application/json' \
    -d "{\"route\":\"${ROUTE}\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"identify the sandbox\"}]}}"; then
  RUN_JSON=$RUN_BOUNDED_OUTPUT
else
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
  if run_bounded_capture curl -fsS "${BASE}/threads/${TID}/state"; then
    STATE_JSON=$RUN_BOUNDED_OUTPUT
  else
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

if read_container_format '{{.Config.Hostname}}' "$APP_ID"; then
  APP_HOSTNAME=$READ_RESULT
else
  fail "could not inspect the owned app container hostname"
fi
[ "$HOST_LINE" != "$APP_HOSTNAME" ] ||
  fail "tool-result hostname '${HOST_LINE}' equals app container hostname; command ran in the app"

if read_container_format '{{.Config.User}}' "$SBX_ID"; then
  SBX_USER=$READ_RESULT
else
  fail "could not inspect owned sandbox container user"
fi
if read_container_format '{{.HostConfig.ReadonlyRootfs}}' "$SBX_ID"; then
  SBX_ROROOTFS=$READ_RESULT
else
  fail "could not inspect owned sandbox rootfs setting"
fi
if read_container_format '{{.Config.Hostname}}' "$SBX_ID"; then
  SBX_HOSTNAME=$READ_RESULT
else
  fail "could not inspect owned sandbox hostname"
fi
if read_container_format '{{.Name}}' "$SBX_ID"; then
  SBX_INSPECTED_NAME=$READ_RESULT
else
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
cleanup_sandbox_through_provider ||
  fail "sandbox container/volume not torn down safely through DELETE /threads/${TID}"

echo "==> OK: sandbox container + volume torn down after DELETE /threads/${TID}"
echo "sandbox-docker-e2e assertions PASSED"
