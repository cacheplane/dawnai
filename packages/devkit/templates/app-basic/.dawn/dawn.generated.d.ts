/// <reference path="./scenarios.generated.d.ts" />

declare module "dawn:routes" {
  export type DawnRoutePath = "/hello/[tenant]";

  export interface DawnRouteParams {
  "/hello/[tenant]": { tenant: string };
  }

  export interface DawnRouteTools {
    "/hello/[tenant]": {
      readonly greet: (input: Parameters<typeof import("../src/app/(public)/hello/[tenant]/tools/greet.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/app/(public)/hello/[tenant]/tools/greet.js").default>>>;
    };
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];

  export interface DawnRouteState {
    "/hello/[tenant]": {
      readonly context: string;
    };
  }

  export type RouteState<P extends DawnRoutePath> = DawnRouteState[P];
}
