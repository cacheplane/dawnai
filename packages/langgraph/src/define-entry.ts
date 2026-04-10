import type { RouteModule } from "./route-module.js";

export function defineEntry<TModule extends RouteModule>(module: TModule): TModule {
  return module;
}
