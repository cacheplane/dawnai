#!/usr/bin/env node

import { run } from "./index.js"

const exitCode = await run(process.argv.slice(2))
process.exit(exitCode)
