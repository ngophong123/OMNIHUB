#!/bin/sh
set -eu
umask 077

endpoint_file="${DR_ALERT_WEBHOOK_URL_FILE:-}"
approved_file="${DR_ALERT_APPROVED_URL_FILE:-}"
if test -z "$endpoint_file" && test -z "$approved_file"; then exit 0; fi
test -n "$endpoint_file" && test -r "$endpoint_file" && test -n "$approved_file" && test -r "$approved_file" || { echo 'ALERT_DESTINATION_FILE_UNREADABLE' >&2; exit 1; }
endpoint="$(cat "$endpoint_file")"
test "$endpoint" = "$(cat "$approved_file")" || { echo 'ALERT_DESTINATION_NOT_APPROVED' >&2; exit 1; }
case "$endpoint" in https://*) ;; *) echo 'ALERT_HTTPS_REQUIRED' >&2; exit 1;; esac
case "$endpoint" in *[!a-zA-Z0-9._~:/%+-]*) echo 'ALERT_DESTINATION_REJECTED' >&2; exit 1;; esac

config="$(mktemp /tmp/omnihub-alert.XXXXXX)" || exit 1
trap 'rm -f -- "$config"' EXIT
printf 'url = "%s"\nrequest = "POST"\nheader = "Content-Type: application/json"\n' "$endpoint" > "$config"
if test -n "${DR_ALERT_BEARER_FILE:-}"; then
  test -r "$DR_ALERT_BEARER_FILE" || { echo 'ALERT_BEARER_FILE_UNREADABLE' >&2; exit 1; }
  bearer="$(cat "$DR_ALERT_BEARER_FILE")"
  case "$bearer" in ''|*[!a-zA-Z0-9._~-]*) echo 'ALERT_BEARER_INVALID' >&2; exit 1;; esac
  printf 'header = "Authorization: Bearer %s"\n' "$bearer" >> "$config"
fi
curl --config "$config" --proto '=https' --tlsv1.2 --fail --silent --show-error --max-time 10 --data-binary @- > /dev/null || { echo 'ALERT_DELIVERY_FAILED' >&2; exit 1; }
