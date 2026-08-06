import { constants } from "node:fs"
import { access } from "node:fs/promises"

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export { isRecord } from "./pure-utils.js"
