#!/bin/sh
set -eu
# ACL file is generated into tmpfs; neither passwords nor ACL contents are logged.
password="$(cat /run/secrets/redis_password)"
printf 'user default off\nuser app on >%s ~omnihub:rate:* &omnihub.events &omnihub:socket.io#* &omnihub:socket.io-request#* &omnihub:socket.io-response#* -@all +ping +echo +hello +quit +select +client|setinfo +client|setname +info +eval +incr +pexpire +pttl +publish +subscribe +unsubscribe +psubscribe +punsubscribe +pubsub|numsub\n' "$password" > /tmp/users.acl
chmod 600 /tmp/users.acl
exec redis-server --appendonly yes --aclfile /tmp/users.acl --protected-mode yes
