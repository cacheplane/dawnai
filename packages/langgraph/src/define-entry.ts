import type { RouteModule } from "./route-module.js";
import { assertExactlyOneEntry } from "./route-module.js";

export function defineEntry<TModule extends RouteModule>(module: TModule): TModule {
  assertExactlyOneEntry(module);
  return module;
}
