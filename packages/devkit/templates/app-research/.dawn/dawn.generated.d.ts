declare module "dawn:routes" {
  export type DawnRoutePath = "/research" | "/research/subagents/researcher";

  export interface DawnRouteParams {
    "/research": {};
    "/research/subagents/researcher": {};
  }

  export interface DawnRouteTools {
    "/research": {
      readonly readDoc: (input: { readonly path: string; }) => Promise<{ content: string; }>;
      readonly searchCorpus: (input: { readonly query: string; }) => Promise<{ readonly path: string; readonly score: number; readonly snippet: string; }[]>;
      readonly writeTodos: (input: { todos: ReadonlyArray<{ content: string; status: "pending" | "in_progress" | "completed" }> }) => Promise<{ todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }>;
      readonly readSkill: (input: { name: string }) => Promise<string>;
      readonly task: (input: { subagent: string; input: string }) => Promise<string>;
      readonly readFile: (input: { path: string }) => Promise<string>;
      readonly writeFile: (input: { path: string; content: string }) => Promise<string>;
      readonly listDir: (input: { path?: string }) => Promise<string[]>;
      readonly runBash: (input: { command: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      readonly remember: (input: { data: Record<string, unknown>; content: string; tags?: string[]; confidence?: number }) => Promise<string>;
      readonly recall: (input: { query?: string; kind?: string; tags?: string[]; limit?: number }) => Promise<string>;
    };
    "/research/subagents/researcher": {
      readonly readDoc: (input: { readonly path: string; }) => Promise<{ content: string; }>;
      readonly searchCorpus: (input: { readonly query: string; }) => Promise<{ readonly path: string; readonly score: number; readonly snippet: string; }[]>;
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
