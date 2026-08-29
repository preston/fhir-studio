#!/usr/bin/env bash
#
# Check to see if any processes are listening on ports required by FHIR Studio
# Ports:
#   3000: FHIR Studio Express Backend & SMART IdP Gateway
#   4200: FHIR Studio Angular UI (Dev Server)
#   5433: PostgreSQL (FHIR Studio & Authentik)
#   6379: Redis (Authentik)
#   8083: HAPI FHIR JPA v8.10 R4 Partitioned Server
#   8084: HAPI FHIR JPA v8.10 R4B Partitioned Server
#   8085: HAPI FHIR JPA v8.10 R5 Partitioned Server
#   9000: Authentik SSO Server
#   9443: Authentik HTTPS Server
#

echo "Checking ports for FHIR Studio..."
for port in 3000 4200 5433 6379 8083 8084 8085 9000 9443; do
  output=$(lsof -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null)
  if [ -n "$output" ]; then
    echo "[BUSY] Port $port is in use:"
    echo "$output"
  else
    echo "[FREE] Port $port is available."
  fi
done
