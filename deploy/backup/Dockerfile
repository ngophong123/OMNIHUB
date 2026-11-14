FROM postgres:18-alpine
RUN apk add --no-cache restic openssh-client jq util-linux curl
COPY deploy/backup/backup.sh /usr/local/bin/omnihub-backup
COPY deploy/backup/offsite.sh /usr/local/bin/omnihub-offsite
COPY deploy/backup/monitor.sh /usr/local/bin/omnihub-dr-monitor
COPY deploy/backup/alert-webhook.sh /usr/local/bin/omnihub-alert-webhook
RUN chmod 755 /usr/local/bin/omnihub-backup /usr/local/bin/omnihub-offsite /usr/local/bin/omnihub-dr-monitor /usr/local/bin/omnihub-alert-webhook
ENTRYPOINT ["/usr/local/bin/omnihub-backup"]
CMD ["schedule"]
