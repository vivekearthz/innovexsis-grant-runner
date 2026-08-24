#!/bin/bash
# Fallback setup script for Lovable deployment
# This ensures the automation directory structure exists even if bundler skips it

set -e

echo "[Lovable Deploy] Verifying automation directory..."
mkdir -p automation
mkdir -p vault

if [ ! -f "automation/package.json" ]; then
    echo "[ERROR] automation/package.json is missing!"
    exit 1
fi

if [ ! -f "automation/autofill-runner.ts" ]; then
    echo "[ERROR] automation/autofill-runner.ts is missing!"
    exit 1
fi

echo "[Lovable Deploy] ✅ Directory structure verified"
