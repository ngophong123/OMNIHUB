#!/bin/sh
set -eu
umask 077
mkdir -p /fixture
printf '{"code":"TEST"}\n' | /usr/local/bin/omnihub-alert-webhook
printf 'https://alerts.example.invalid/ingest\n' > /fixture/approved
printf 'https://unapproved.example.invalid/ingest\n' > /fixture/endpoint
export DR_ALERT_WEBHOOK_URL_FILE=/fixture/endpoint
export DR_ALERT_APPROVED_URL_FILE=/fixture/approved
if printf '{"code":"TEST"}\n' | /usr/local/bin/omnihub-alert-webhook; then
  echo 'UNAPPROVED_ALERT_ACCEPTED' >&2
  exit 1
fi
printf 'http://alerts.example.invalid/ingest\n' > /fixture/endpoint
printf 'http://alerts.example.invalid/ingest\n' > /fixture/approved
if printf '{"code":"TEST"}\n' | /usr/local/bin/omnihub-alert-webhook; then
  echo 'INSECURE_ALERT_ACCEPTED' >&2
  exit 1
fi
echo 'ALERT_DESTINATION_GATES_PASSED'
