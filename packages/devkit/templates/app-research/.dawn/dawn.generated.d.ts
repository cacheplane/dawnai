/// <reference path="./scenarios.generated.d.ts" />

declare module "dawn:routes" {
  export type DawnRoutePath = "/research" | "/research/subagents/researcher";

  export interface DawnRouteParams {
  "/research": {};
  "/research/subagents/researcher": {};
  }

  export interface DawnRouteTools {
    "/research": {
      readonly readDoc: (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>;
      readonly searchCorpus: (input: Parameters<typeof import("../src/tools/searchCorpus.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/searchCorpus.js").default>>>;
      readonly writeTodos: (input: { todos: ReadonlyArray<{ content: string; status: "pending" | "in_progress" | "completed" }> }) => Promise<{ todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }>;
      readonly readSkill: (input: { name: string }) => Promise<string>;
      readonly task: (input: { subagent: string; input: string }) => Promise<string>;
      readonly readFile: (input: { path: string }) => Promise<string>;
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>;
      readonly listDir: (input: { path?: string }) => Promise<string[]>;
      readonly runBash: (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      readonly remember: (input: { data: import("zod").infer<(typeof import("../src/app/research/memory").default)["schema"]>; content: string; tags?: string[]; confidence?: number }) => Promise<string>;
      readonly recall: (input: { query?: string; kind?: "semantic" | "episodic" | "procedural" | "reflection"; tags?: string[]; limit?: number }) => Promise<string>;
    };
    "/research/subagents/researcher": {
      readonly readDoc: (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>;
      readonly searchCorpus: (input: Parameters<typeof import("../src/tools/searchCorpus.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/searchCorpus.js").default>>>;
      readonly readFile: (input: { path: string }) => Promise<string>;
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>;
      readonly listDir: (input: { path?: string }) => Promise<string[]>;
      readonly runBash: (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    };
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];

  export interface DawnRouteState {
    "/research": {
      readonly context: string;
    };
  }

  export type RouteState<P extends DawnRoutePath> = DawnRouteState[P];
}
