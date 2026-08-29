#!/usr/bin/env node
import { runOwnerPreflightCli } from "./preflight-owner-cli.mjs"

process.exitCode = await runOwnerPreflightCli()
