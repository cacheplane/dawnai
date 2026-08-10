#!/usr/bin/env node

if (process.argv.includes("--assert-receipt")) {
  throw new Error("native Vercel receipt assertion is not implemented")
}

if (process.argv.includes("--prepare-artifacts")) {
  throw new Error("native Vercel diagnostic preparation is not implemented")
}
