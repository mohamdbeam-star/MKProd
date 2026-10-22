#!/bin/zsh
# Builds E2E.swift into a CLI and checks it byte-for-byte against web/src/crypto.ts.
set -euo pipefail
cd "$(dirname "$0")"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
xcodebuild -version >/dev/null 2>&1 || export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
cat > "$WORK/shim.swift" <<'S'
import Foundation
struct CloudError: LocalizedError { let message: String; var errorDescription: String? { message } }
S
swiftc -parse-as-library -O -o "$WORK/tool" ../../Sources/MKProd/E2E.swift CryptoTool.swift "$WORK/shim.swift"
../../web/node_modules/.bin/esbuild ../../web/src/crypto.ts --format=esm --outfile="$WORK/crypto.mjs" --log-level=warning
cp run.mjs "$WORK/run.mjs"
node "$WORK/run.mjs" "$WORK/tool"
