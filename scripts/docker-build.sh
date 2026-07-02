#!/bin/bash
set -e
cd "$(dirname "$0")/.."
echo "=== Building NovaChat C++ user-service Docker image ==="
docker build -t novachat-user-service . 2>&1
echo "=== Build complete ==="
