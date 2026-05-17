import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { CapabilityMarker, PromptFragment } from "../types.js"
import { parseFrontmatter } from "./frontmatter.js"

const SKILLS_DIR = "skills"
const SKILL_FILE = "SKILL.md"
// Directory name must be a valid kebab-case-ish identifier. We exclude dotfiles,
// spaces, and other punctuation that would make a poor agent-facing name.
const VALID_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const SKILLS_PROMPT_HEADER = `# Skills

The following skills are available. To use one, call \`readSkill({ name: "<name>" })\` to load its full instructions before acting.`

const READ_SKILL_INPUT = z.object({
  name: z.string().min(1),
})

interface LoadedSkill {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly path: string
}

export function createSkillsMarker(): CapabilityMarker {
  return {
    name: "skills",
    detect: async (routeDir) => discoverSkillDirs(routeDir).length > 0,
    load: async (routeDir) => {
      const skills = loadSkills(routeDir)

      const readSkill = {
        name: "readSkill",
        description: "Load the full instructions for a named skill.",
        schema: READ_SKILL_INPUT,
        run: async (input: unknown) => {
          const { name } = READ_SKILL_INPUT.parse(input)
          const found = skills.find((s) => s.name === name)
          if (!found) {
            const available = skills.map((s) => s.name).sort().join(", ")
            return `Unknown skill: ${name}. Available: ${available}`
          }
          return found.body
        },
      }

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
        render: () => {
          const lines = skills
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((s) => `- **${s.name}** — ${s.description}`)
            .join("\n")
          return `${SKILLS_PROMPT_HEADER}\n\n${lines}`
        },
      }

      return {
        tools: [readSkill],
        promptFragment,
      }
    },
  }
}

function discoverSkillDirs(routeDir: string): readonly string[] {
  const skillsDir = join(routeDir, SKILLS_DIR)
  if (!existsSync(skillsDir)) return []
  let entries: string[]
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  return entries.filter((name) => {
    if (!VALID_DIR_NAME.test(name)) return false
    const full = join(skillsDir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      return false
    }
    if (!stat.isDirectory()) return false
    return existsSync(join(full, SKILL_FILE))
  })
}

function loadSkills(routeDir: string): readonly LoadedSkill[] {
  const dirNames = discoverSkillDirs(routeDir)
  const loaded: LoadedSkill[] = []
  const seenNames = new Set<string>()

  for (const dirName of dirNames) {
    const path = join(routeDir, SKILLS_DIR, dirName, SKILL_FILE)
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch (error) {
      throw new Error(`Failed to read ${path}: ${(error as Error).message}`)
    }
    const { frontmatter, body } = parseFrontmatter(raw)
    if (Object.keys(frontmatter).length === 0) {
      throw new Error(
        `${path} is missing required frontmatter. Add a YAML block at the top with at least \`description: …\`.`,
      )
    }
    const description = frontmatter.description
    if (!description || description.length === 0) {
      throw new Error(`${path} frontmatter is missing required \`description\` field.`)
    }
    const name = frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : dirName
    if (seenNames.has(name)) {
      const dupPath = loaded.find((s) => s.name === name)?.path
      throw new Error(
        `Duplicate skill name "${name}" — collision between ${dupPath} and ${path}. Each skill name must be unique.`,
      )
    }
    seenNames.add(name)
    loaded.push({ name, description, body, path })
  }

  return loaded
}
