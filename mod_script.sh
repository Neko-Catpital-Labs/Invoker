#!/bin/bash
sudo chown root:root "$(dirname "$0")/node_modules/.pnpm/electron@35.7.5/node_modules/electron/dist/chrome-sandbox"
sudo chmod 4755 "$(dirname "$0")/node_modules/.pnpm/electron@35.7.5/node_modules/electron/dist/chrome-sandbox"
echo "chrome-sandbox permissions fixed."
