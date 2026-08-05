@echo off
REM Run the safety and idempotency test suite against a local, credential-free
REM PostgreSQL instance. Requires Docker Desktop.
REM
REM Usage:
REM   scripts\test-local.cmd

cd /d "%~dp0.."

echo Starting local PostgreSQL (port 5433)...
docker compose up -d --wait
if errorlevel 1 (
    echo ERROR: Could not start PostgreSQL container.
    exit /b 1
)

echo Running tests against local database...
set DATABASE_URL=postgresql://test:test@localhost:5433/commerce_ops_test
call npx vitest run
set TEST_EXIT=%errorlevel%

echo Tearing down local PostgreSQL...
docker compose down -v

exit /b %TEST_EXIT%
