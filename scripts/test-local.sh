#!/usr/bin/env bash
# Run the safety and idempotency test suite against a local, credential-free
# PostgreSQL instance. Requires Docker (or Podman with docker-compose support).
#
# Usage:
#   ./scripts/test-local.sh
#
# This script:
#   1. Starts a disposable PostgreSQL container on port 5433
#   2. Waits for it to accept connections
#   3. Runs the test suite against it
#   4. Tears down the container regardless of outcome

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "▶ Starting local PostgreSQL (port 5433)…"
docker compose up -d --wait

echo "▶ Running tests against local database…"
DATABASE_URL="postgresql://test:test@localhost:5433/commerce_ops_test" npx vitest run
TEST_EXIT=$?

echo "▶ Tearing down local PostgreSQL…"
docker compose down -v

exit $TEST_EXIT
