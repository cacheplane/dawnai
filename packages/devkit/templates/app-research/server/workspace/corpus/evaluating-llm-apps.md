# Evaluating LLM apps

Treat evaluation as code: a dataset of cases, one or more scorers, and a gate
that turns scores into a pass/fail decision.

- **Deterministic scorers** (exact match, contains, regex, tool-called) are
  cheap and stable; prefer them where the expected behavior is well-defined.
- **LLM-as-judge** scorers grade open-ended quality against written criteria;
  use them when there is no single correct string.
- **Gates** (mean, pass-rate, per-scorer) decide whether a run ships. Run evals
  in replay by default so they are deterministic and offline; run them live to
  measure against the real model.
