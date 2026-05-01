declare module "dawn:routes" {
  export type DawnRoutePath = "/hello/[tenant]";

  export interface DawnRouteParams {
  "/hello/[tenant]": { tenant: string };
  }

  export interface DawnRouteTools {
    "/hello/[tenant]": {
      readonly greet: (input: { readonly tenant: string; }) => Promise<{ name: string; plan: string; }>;
    };
  }

  export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
}
