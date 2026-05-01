import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import type { TemplateName } from "../templates.js"
import { resolveTemplateDir } from "../templates.js"
import { writeTemplate } from "../write-template.js"

export interface GeneratedAppSpecifiers {
  readonly dawnCli: string
  readonly dawnConfigTypescript: string
  readonly dawnCore: string
  readonly dawnLangchain: string
  readonly dawnSdk: string
}

export interface CreateGeneratedAppOptions {
  readonly appName: string
  readonly artifactRoot: string
  readonly specifiers?: Partial<GeneratedAppSpecifiers>
  readonly targetDir?: string
  readonly template: TemplateName
}

export interface GeneratedApp {
  readonly appName: string
  readonly appRoot: string
  readonly artifactRoot: string
  readonly template: TemplateName
  readonly templateDir: string
  readonly transcriptPath: string
}

export async function createGeneratedApp(
  options: CreateGeneratedAppOptions,
): Promise<GeneratedApp> {
  const templateDir = await resolveTemplateDir(options.template)
  const appRoot = resolve(options.targetDir ?? resolve(options.artifactRoot, "app"))
  const transcriptPath = resolve(options.artifactRoot, "transcripts", "generated-app.log")
  const specifiers = normalizeSpecifiers(options.specifiers)

  await mkdir(resolve(options.artifactRoot, "transcripts"), { recursive: true })
  await writeTemplate({
    replacements: {
      appName: options.appName,
      dawnCliSpecifier: specifiers.dawnCli,
      dawnConfigTypescriptSpecifier: specifiers.dawnConfigTypescript,
      dawnCoreSpecifier: specifiers.dawnCore,
      dawnLangchainSpecifier: specifiers.dawnLangchain,
      dawnSdkSpecifier: specifiers.dawnSdk,
    },
    targetDir: appRoot,
    templateDir,
  })

  return {
    appName: options.appName,
    appRoot,
    artifactRoot: options.artifactRoot,
    template: options.template,
    templateDir,
    transcriptPath,
  }
}

function normalizeSpecifiers(
  specifiers: Partial<GeneratedAppSpecifiers> | undefined,
): GeneratedAppSpecifiers {
  return {
    dawnCli: specifiers?.dawnCli ?? "workspace:*",
    dawnConfigTypescript: specifiers?.dawnConfigTypescript ?? "workspace:*",
    dawnCore: specifiers?.dawnCore ?? "workspace:*",
    dawnLangchain: specifiers?.dawnLangchain ?? "workspace:*",
    dawnSdk: specifiers?.dawnSdk ?? "workspace:*",
  }
}
