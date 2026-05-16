export interface PlanTodo {
  readonly content: string
  readonly status: "pending" | "completed"
}

const CHECKLIST_LINE = /^\s*-\s*\[([ xX])\]\s*(.*)$/

export function parsePlanMarkdown(input: string): PlanTodo[] {
  const todos: PlanTodo[] = []
  for (const line of input.split(/\r?\n/)) {
    const match = CHECKLIST_LINE.exec(line)
    if (!match) continue
    const checkChar = match[1] ?? " "
    const content = (match[2] ?? "").trim()
    if (content.length === 0) continue
    todos.push({
      content,
      status: checkChar === " " ? "pending" : "completed",
    })
  }
  return todos
}
