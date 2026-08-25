import { Buffer } from "node:buffer"
import { parentPort, workerData } from "node:worker_threads"

import { JSDOM } from "jsdom"

const diagram = "flowchart LR\n  Start[Start] --> Done[Done]"
const maxSvgBytes = 256_000
const prototypeMarkers = [
  "mermaidConfigPrototypePollutionMarker",
  "mermaidPrototypePollutionMarker",
]
const securityCaseNames = new Set([
  "architecture-prototype",
  "config-prototype",
  "css-sibling",
  "radar-ticks",
  "strict-integration",
  "xy-axis",
])

if (parentPort === null) {
  throw new Error("Mermaid render worker requires a parent port")
}

function sameDescriptor(left, right) {
  if (left === undefined || right === undefined) return left === right
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.get === right.get &&
    left.set === right.set &&
    left.value === right.value &&
    left.writable === right.writable
  )
}

function installProperty(target, name, value, snapshots) {
  snapshots.push([target, name, Object.getOwnPropertyDescriptor(target, name)])
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  })
}

function restoreProperties(snapshots) {
  for (const [target, name, descriptor] of [...snapshots].reverse()) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(target, name)
    } else {
      Object.defineProperty(target, name, descriptor)
    }
  }
  return snapshots.every(([target, name, descriptor]) =>
    sameDescriptor(Object.getOwnPropertyDescriptor(target, name), descriptor),
  )
}

function snapshotProperty(target, name, snapshots) {
  snapshots.push([target, name, Object.getOwnPropertyDescriptor(target, name)])
}

function prototypesAreClean() {
  return prototypeMarkers.every((name) => !Object.hasOwn(Object.prototype, name))
}

function inspectActiveMermaidConfig(mermaid, marker) {
  const mermaidApi = mermaid?.mermaidAPI
  if (
    mermaidApi === null ||
    typeof mermaidApi !== "object" ||
    typeof mermaidApi.getConfig !== "function"
  ) {
    throw new Error("Mermaid API does not expose its active configuration")
  }
  const activeConfig = mermaidApi.getConfig()
  if (activeConfig === null || typeof activeConfig !== "object") {
    throw new Error("Mermaid API returned an invalid active configuration")
  }
  const activeConfigPrototype = Object.getPrototypeOf(activeConfig)
  return {
    markerAbsent: activeConfig[marker] === undefined,
    prototypeClean:
      activeConfigPrototype === Object.prototype && !Object.hasOwn(activeConfigPrototype, marker),
  }
}

function requireRenderedSvg(rendered) {
  if (rendered === null || typeof rendered !== "object" || typeof rendered.svg !== "string") {
    throw new Error("Mermaid did not return an SVG string")
  }
  const utf8Bytes = Buffer.byteLength(rendered.svg, "utf8")
  if (utf8Bytes === 0 || utf8Bytes > maxSvgBytes) {
    throw new Error("Mermaid SVG exceeded the worker receipt boundary")
  }
  return rendered.svg
}

async function settleSecurityCase(action) {
  try {
    return { settled: "fulfilled", value: await action() }
  } catch (error) {
    return {
      diagnostic:
        error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 240) : "unknown error",
      settled: "rejected",
    }
  }
}

function cssSiblingIsContained(window, svg, diagramId) {
  const parsed = new window.DOMParser().parseFromString(svg, "image/svg+xml")
  const styles = [...parsed.querySelectorAll("style")]
    .map((style) => style.textContent ?? "")
    .join("\n")
  const safeSelector = new RegExp(
    `(?:^|\\})\\s*#${diagramId}\\s+#${diagramId}\\s*\\+\\s*\\*\\s*\\{`,
    "u",
  )
  const escapingSelector = new RegExp(`(?:^|\\})\\s*#${diagramId}\\s*\\+\\s*\\*\\s*\\{`, "u")
  return safeSelector.test(styles) && !escapingSelector.test(styles)
}

function strictIntegrationIsSanitized(window, svg) {
  const parsed = new window.DOMParser().parseFromString(svg, "image/svg+xml")
  if (parsed.querySelector("parsererror") !== null) return false
  if (parsed.querySelector("script, iframe, object, embed") !== null) return false

  for (const element of parsed.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (/^on/iu.test(attribute.name)) return false
      if (
        /^(?:action|formaction|href|src|xlink:href)$/iu.test(attribute.name) &&
        /^\s*javascript:/iu.test(attribute.value)
      ) {
        return false
      }
    }
  }

  return [...parsed.querySelectorAll("style")].every(
    (style) => !(style.textContent ?? "").includes("mermaidStrictEscapeMarker"),
  )
}

async function runSecurityCase(mermaid, window, securityCase) {
  const prototypeCleanBefore = prototypesAreClean()
  let activeConfigAfter
  let activeConfigBefore
  let result

  switch (securityCase) {
    case "xy-axis":
      result = await settleSecurityCase(async () => {
        requireRenderedSvg(
          await mermaid.render(
            "xy-axis-worker-diagram",
            "xychart\n  x-axis 1 --> 1\n  line [1, 2]",
          ),
        )
      })
      break
    case "architecture-prototype":
      result = await settleSecurityCase(async () => {
        requireRenderedSvg(
          await mermaid.render(
            "architecture-prototype-worker-diagram",
            [
              "architecture-beta",
              "  group mermaidPrototypePollutionMarker(cloud)[Marker]",
              "  service a(server)[A] in __proto__",
              "  service b(server)[B] in mermaidPrototypePollutionMarker",
              "  a:R -- L:b",
            ].join("\n"),
          ),
        )
      })
      break
    case "css-sibling": {
      const diagramId = "css-sibling-worker-diagram"
      result = await settleSecurityCase(async () => {
        const svg = requireRenderedSvg(
          await mermaid.render(
            diagramId,
            [
              "---",
              "config:",
              "  themeCSS: |-",
              "    & + * { color: rgb(1, 2, 3) !important; }",
              "---",
              "info",
            ].join("\n"),
          ),
        )
        return cssSiblingIsContained(window, svg, diagramId)
      })
      break
    }
    case "config-prototype":
      activeConfigBefore = inspectActiveMermaidConfig(
        mermaid,
        "mermaidConfigPrototypePollutionMarker",
      )
      result = await settleSecurityCase(async () => {
        mermaid.initialize({
          ["__proto__"]: {
            mermaidConfigPrototypePollutionMarker: true,
          },
          securityLevel: "strict",
          startOnLoad: false,
          suppressErrorRendering: true,
        })
      })
      activeConfigAfter = inspectActiveMermaidConfig(
        mermaid,
        "mermaidConfigPrototypePollutionMarker",
      )
      break
    case "radar-ticks":
      result = await settleSecurityCase(async () => {
        requireRenderedSvg(
          await mermaid.render(
            "radar-ticks-worker-diagram",
            "radar-beta\n  axis a, b\n  curve c {1, 1}\n  ticks 1000000000",
          ),
        )
      })
      break
    case "strict-integration":
      result = await settleSecurityCase(async () => {
        const svg = requireRenderedSvg(
          await mermaid.render(
            "strict-integration-worker-diagram",
            [
              "flowchart LR",
              "  Unsafe[\"<svg onload='void 0'><text>Unsafe SVG</text></svg><a href='javascript:void 0' onmouseover='void 0'>Unsafe link</a><style>.mermaidStrictEscapeMarker{display:none}</style>\"]",
              "  Unsafe --> Safe[Safe]",
            ].join("\n"),
          ),
        )
        return strictIntegrationIsSanitized(window, svg)
      })
      break
  }

  const receipt = {
    ...(securityCase === "config-prototype" ? { activeConfigAfter, activeConfigBefore } : {}),
    ...(result.settled === "rejected" ? { diagnostic: result.diagnostic } : {}),
    name: securityCase,
    prototypeCleanAfter: prototypesAreClean(),
    prototypeCleanBefore,
    settled: result.settled,
  }
  if (securityCase === "css-sibling") {
    receipt.safeCss = result.settled === "fulfilled" && result.value === true
  }
  if (securityCase === "strict-integration") {
    receipt.sanitized = result.settled === "fulfilled" && result.value === true
  }
  return receipt
}

async function renderBenignDiagram() {
  const mermaidEsmUrl = workerData?.mermaidEsmUrl
  const securityCase = workerData?.securityCase
  if (
    typeof mermaidEsmUrl !== "string" ||
    !mermaidEsmUrl.startsWith("file:") ||
    mermaidEsmUrl.length > 4_096
  ) {
    throw new Error("invalid Mermaid ESM URL")
  }
  if (
    securityCase !== undefined &&
    (typeof securityCase !== "string" || !securityCaseNames.has(securityCase))
  ) {
    throw new Error("invalid Mermaid security case")
  }

  const dom = new JSDOM(
    '<!doctype html><html><body><main id="harness-root"></main></body></html>',
    {
      pretendToBeVisual: true,
      url: "http://127.0.0.1/",
    },
  )
  const { window } = dom
  const snapshots = []
  let globalsRestored = false
  let realmClosed = false
  let outcome

  try {
    for (const marker of prototypeMarkers) {
      snapshotProperty(Object.prototype, marker, snapshots)
    }
    const globalBindings = {
      CSSStyleDeclaration: window.CSSStyleDeclaration,
      CSSStyleSheet: window.CSSStyleSheet,
      CustomEvent: window.CustomEvent,
      DOMParser: window.DOMParser,
      Element: window.Element,
      Event: window.Event,
      HTMLElement: window.HTMLElement,
      HTMLIFrameElement: window.HTMLIFrameElement,
      MutationObserver: window.MutationObserver,
      Node: window.Node,
      NodeList: window.NodeList,
      SVGElement: window.SVGElement,
      XMLSerializer: window.XMLSerializer,
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      document: window.document,
      getComputedStyle: window.getComputedStyle.bind(window),
      location: window.location,
      navigator: window.navigator,
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      self: window,
      window,
    }
    for (const [name, value] of Object.entries(globalBindings)) {
      installProperty(globalThis, name, value, snapshots)
    }

    installProperty(
      window.SVGElement.prototype,
      "getBBox",
      () => ({ height: 16, width: 64, x: 0, y: 0 }),
      snapshots,
    )
    installProperty(window.SVGElement.prototype, "getComputedTextLength", () => 64, snapshots)

    // This import must remain after the jsdom globals are installed. Mermaid's
    // DOMPurify integration binds to the active window during module evaluation.
    const namespace = await import(mermaidEsmUrl)
    const mermaid = namespace.default
    if (
      mermaid === null ||
      typeof mermaid !== "object" ||
      typeof mermaid.initialize !== "function" ||
      typeof mermaid.render !== "function"
    ) {
      throw new Error("resolved Mermaid ESM entry has an unexpected shape")
    }
    mermaid.initialize({
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
    })
    const rendered = await mermaid.render("benign-worker-diagram", diagram)
    const svg = requireRenderedSvg(rendered)
    const utf8Bytes = Buffer.byteLength(svg, "utf8")
    outcome = {
      diagram: {
        hasSvg: /^\s*<svg\b/u.test(svg),
        textLabels: Number(svg.includes("Start")) + Number(svg.includes("Done")),
        utf8Bytes,
      },
      ok: true,
      ...(securityCase !== undefined
        ? { securityCase: await runSecurityCase(mermaid, window, securityCase) }
        : {}),
    }
  } catch (error) {
    outcome = {
      error: {
        code: "BENIGN_MERMAID_RENDER_FAILED",
        message: error instanceof Error ? error.message.slice(0, 400) : "unknown worker error",
        name: error instanceof Error ? error.name.slice(0, 80) : "Error",
      },
      ok: false,
    }
  } finally {
    try {
      globalsRestored = restoreProperties(snapshots)
    } finally {
      dom.window.close()
      realmClosed = true
    }
  }

  return {
    ...outcome,
    cleanup: { globalsRestored, realmClosed },
  }
}

parentPort.postMessage(await renderBenignDiagram())
parentPort.close()
