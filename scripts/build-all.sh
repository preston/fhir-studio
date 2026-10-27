#!/usr/bin/env bash
#
# Build all Docker images for FHIR Studio
#
# Usage:
#   ./scripts/build-all.sh
#
# This script builds the Docker images for the FHIR Studio server and UI.
# It uses Docker Buildx to build for both ARM64 and AMD64 architectures.
#

echo "Building FHIR Studio server..."
docker buildx build --platform linux/arm64,linux/amd64 -f server/Dockerfile -t p3000/fhir-studio-server:latest .
echo "Building FHIR Studio UI..."
docker buildx build --platform linux/arm64,linux/amd64 -f ui/Dockerfile -t p3000/fhir-studio-ui:latest .