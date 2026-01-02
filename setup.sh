#!/bin/bash
# Dorker Setup - runs the main setup script
cd "$(dirname "$0")"
./scripts/setup.sh "$@"
