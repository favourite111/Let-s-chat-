#!/bin/bash
# Runs after a merge. Keep it fast and never fail the merge on optional steps.
set -e

pnpm install --frozen-lockfile

# The Drizzle database package is optional scaffolding: only push the schema
# when a database is actually provisioned for this environment.
if [ -n "${DATABASE_URL:-}" ]; then
  pnpm --filter @workspace/db run push
else
  echo "post-merge: DATABASE_URL not set, skipping database push"
fi
