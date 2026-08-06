// Deliberately fails at load time: identity resolution must PROPAGATE this
// (the inspector approve route returns 500), never silently reconcile with
// default identity keys.
throw new Error("broken memory.ts fixture")
