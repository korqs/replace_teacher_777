#!/bin/sh
set -e

echo "🔧 Ожидание готовности PostgreSQL..."
until node -e "
const { testConnection } = require('./init_db');
testConnection().then((ok) => process.exit(ok ? 0 : 1)).catch(() => process.exit(1));
" 2>/dev/null; do
  echo "   PostgreSQL ещё не готов, повтор через 2 с..."
  sleep 2
done

echo "✅ PostgreSQL доступен"
exec "$@"
