declare module "dawn:routes" {
  export type DawnRoutePath = "/research";

  export interface DawnRouteParams {
    "/research": {};
  }

  export interface DawnRouteTools {
    "/research": {
      readonly searchCorpus: (input: { readonly query: string; }) => Promise<{ readonly path: string; readonly score: number; readonly snippet: string; }[]>;
      readonly readDoc: (input: { readonly path: string; }) => Promise<{ content: string; }>;
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
