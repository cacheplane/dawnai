import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const TEMPLATE_NAMES = ["basic"] as const

export type TemplateName = (typeof TEMPLATE_NAMES)[number]

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const templatesRoot = resolve(packageRoot, "templates")

export async function resolveTemplateDir(templateName: string): Promise<string> {
  if (!isTemplateName(templateName)) {
    throw new Error(
      `Unsupported Dawn template "${templateName}". Supported templates: ${TEMPLATE_NAMES.join(", ")}`,
    )
  }

  const templateDir = resolve(templatesRoot, `app-${templateName}`)
  await access(templateDir, constants.F_OK)

  return templateDir
}

function isTemplateName(templateName: string): templateName is TemplateName {
  return TEMPLATE_NAMES.includes(templateName as TemplateName)
}
