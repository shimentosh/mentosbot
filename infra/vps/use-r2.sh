#!/bin/bash
# Store Rakazo bot files (computer homes) and new artifacts in Cloudflare R2.
# Run as root on the VPS:   bash use-r2.sh
# Asks for the R2 details here on the server, so keys never leave it.
# Files are encrypted by Rakazo before upload; R2 only ever holds ciphertext.
set -euo pipefail
cd /srv/rakazo
COMPOSE="docker compose -f docker-compose.images.yml --env-file .env"

read -rp  "Cloudflare Account ID: " ACCOUNT
read -rp  "R2 bucket name: " BUCKET
read -rp  "R2 Access Key ID: " KEY_ID
read -rsp "R2 Secret Access Key (hidden): " SECRET; echo
ENDPOINT="https://${ACCOUNT}.r2.cloudflarestorage.com"

echo "==> Testing R2 (write, read, delete one small object)"
S3=$(docker exec rakazo-api-1 sh -c 'ls -d /app/node_modules/.pnpm/@aws-sdk+client-s3@*/node_modules/@aws-sdk/client-s3 | head -1')
docker exec -i -e S3="$S3" -e EP="$ENDPOINT" -e B="$BUCKET" -e K="$KEY_ID" -e S="$SECRET" rakazo-api-1 node --input-type=module - <<'JS'
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import(process.env.S3 + "/dist-cjs/index.js");
const c = new S3Client({ region: "auto", endpoint: process.env.EP, forcePathStyle: true,
  credentials: { accessKeyId: process.env.K, secretAccessKey: process.env.S } });
const Key = `rakazo-connection-test-${Date.now()}`;
try {
  await c.send(new PutObjectCommand({ Bucket: process.env.B, Key, Body: "ok" }));
  const got = await (await c.send(new GetObjectCommand({ Bucket: process.env.B, Key }))).Body.transformToString();
  await c.send(new DeleteObjectCommand({ Bucket: process.env.B, Key }));
  if (got !== "ok") throw new Error("read back the wrong content");
  console.log("R2 OK");
} catch (e) { console.error("R2 test failed:", e.name, e.message); process.exit(1); }
JS

echo "==> Saving settings"
setv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
setv OBJECT_STORAGE_BUCKET "$BUCKET"
setv OBJECT_STORAGE_ENDPOINT "$ENDPOINT"
setv OBJECT_STORAGE_REGION auto
setv OBJECT_STORAGE_ACCESS_KEY_ID "$KEY_ID"
setv OBJECT_STORAGE_SECRET_ACCESS_KEY "$SECRET"
setv OBJECT_STORAGE_PATH_STYLE true
chmod 600 .env
$COMPOSE up -d --wait --pull never api worker >/dev/null

echo "==> Moving existing bot files to R2 (local copies are kept)"
docker exec -w /app/apps/api rakazo-api-1 /app/node_modules/.bin/tsx src/cli/home-storage.ts migrate 2>&1 | tail -15
echo "Done. New bot files and artifacts now go to R2."
