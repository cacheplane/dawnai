import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export interface TemplateReplacements {
  readonly [key: string]: string
}

export interface WriteTemplateOptions {
  readonly replacements: TemplateReplacements
  readonly targetDir: string
  readonly templateDir: string
}

export async function writeTemplate(options: WriteTemplateOptions): Promise<void> {
  await mkdir(options.targetDir, { recursive: true })
  await copyTemplateTree(options.templateDir, options.targetDir, options.replacements)
}

async function copyTemplateTree(
  sourceDir: string,
  targetDir: string,
  replacements: TemplateReplacements,
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true })

  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = join(sourceDir, entry.name)
      const targetPath = join(targetDir, toOutputName(entry.name))

      if (entry.isDirectory()) {
        await mkdir(targetPath, { recursive: true })
        await copyTemplateTree(sourcePath, targetPath, replacements)
        return
      }

      const templateSource = await readFile(sourcePath, "utf8")
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, applyReplacements(templateSource, replacements), "utf8")
    }),
  )
}

function toOutputName(entryName: string): string {
  if (entryName === "npmrc.template") {
    return ".npmrc"
  }

  if (entryName === "gitignore.template") {
    return ".gitignore"
  }

  return entryName.endsWith(".template") ? basename(entryName, ".template") : entryName
}

function applyReplacements(source: string, replacements: TemplateReplacements): string {
  return Object.entries(replacements).reduce(
    (currentSource, [token, value]) => currentSource.replaceAll(`{{${token}}}`, value),
    source,
  )
}
