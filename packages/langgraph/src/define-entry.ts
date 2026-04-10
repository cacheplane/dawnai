import type { RouteModule } from "./route-module.js";
import { assertExactlyOneEntry } from "./route-module.js";

export function defineEntry<TEntry, TModule extends RouteModule<TEntry>>(module: TModule): TModule {
  assertExactlyOneEntry(module);
  return module;
}
