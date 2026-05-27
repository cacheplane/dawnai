/**
 * This module previously re-exported the in-memory pending-interrupts registry
 * from `@dawn-ai/langchain`. The interrupt resume mechanism has been replaced
 * with a state-based approach that reads from the SQLite checkpoint's
 * `__interrupt__` pending writes — no in-memory promise parking is needed.
 *
 * This file is kept as a placeholder to avoid breaking any external imports
 * during the transition. It will be deleted in the follow-on cleanup commit.
 *
 * @deprecated Use the checkpoint-based resume endpoint instead.
 */
