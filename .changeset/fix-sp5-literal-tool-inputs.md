---
"@dawn-ai/core": patch
---

Fix tool-input schema extraction for standalone literal types. A single string-literal type (e.g. a discriminated-union discriminant like `by: "date"`) was not recognized as an enum (only multi-member literal unions were), so it fell through to object extraction and was misread as an object carrying `String.prototype` methods (`charAt`, `toString`, …). This produced a bogus schema that rejected the correct argument, breaking every discriminated/object-union tool parameter end-to-end. Standalone string/number/boolean literals now extract correctly, and object extraction is guarded to genuine object types. Found by a live-API smoke test.
