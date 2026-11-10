#!/bin/sh
set -eu

# Without these Litestream would fail on its first network call with a message that
# does not say which setting is missing. The values are never printed.
: "${R2_ENDPOINT:?R2_ENDPOINT is not set}"
: "${LITESTREAM_ACCESS_KEY_ID:?LITESTREAM_ACCESS_KEY_ID is not set}"
: "${LITESTREAM_SECRET_ACCESS_KEY:?LITESTREAM_SECRET_ACCESS_KEY is not set}"

# A missing database is restored from R2 before the app opens it. A first boot with no
# replica is allowed to proceed, while a real restore error exits non-zero instead of
# starting on an empty disk and streaming that emptiness over the only backup.
exec /usr/local/bin/litestream replicate \
  -config /app/tools/litestream.yml \
  -restore-if-db-not-exists \
  -exec "$*"
