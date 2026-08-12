import { readdir, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { posix, relative, resolve } from "node:path"

import { readPublicPackages } from "./published-artifacts.mjs"

const requireFromCore = createRequire(
  resolve(import.meta.dirname, "../../packages/core/package.json"),
)
const ts = requireFromCore("typescript")
const NAVIGATION_ONLY_MDX_COMPONENTS = new Set(["RelatedCards"])
const AUTOLINK_PATTERN =
  /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/g

export function manifestExportSubpaths(exportsField) {
  if (exportsField === undefined || exportsField === null) return []
  if (typeof exportsField !== "object" || Array.isArray(exportsField)) return ["."]
  const keys = Object.keys(exportsField)
  const subpaths = keys.filter((key) => key === "." || key.startsWith("./"))
  return subpaths.length > 0 ? subpaths : ["."]
}

export function manifestArtifactEntries(manifests) {
  return manifests.flatMap((manifest) => {
    const entries = manifestExportSubpaths(manifest.exports).map((subpath) => ({
      address: `import:${manifest.name}:${subpath}`,
    }))

    if (typeof manifest.bin === "string") {
      const binName = manifest.name.replace(/^@[^/]+\//, "")
      entries.push({
        address: `operated:${manifest.name}:bin.${binName}`,
        manifestTarget: manifest.bin,
      })
    } else {
      for (const [binName, manifestTarget] of Object.entries(manifest.bin ?? {})) {
        entries.push({
          address: `operated:${manifest.name}:bin.${binName}`,
          manifestTarget,
        })
      }
    }

    if (typeof manifest.dawnInspector?.server === "string") {
      entries.push({
        address: `operated:${manifest.name}:dawnInspector.server`,
        manifestTarget: manifest.dawnInspector.server,
      })
    }
    return entries
  })
}

function exportValueAtSubpath(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return undefined
  if (typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return subpath === "." ? exportsField : undefined
  }
  const keys = Object.keys(exportsField)
  const hasSubpaths = keys.some((key) => key === "." || key.startsWith("./"))
  return hasSubpaths ? exportsField[subpath] : subpath === "." ? exportsField : undefined
}

function relevantExportTarget(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = relevantExportTarget(candidate)
      if (target) return target
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  for (const condition of ["types", "import", "default", "node", "require"]) {
    const target = relevantExportTarget(value[condition])
    if (target) return target
  }
  for (const candidate of Object.values(value)) {
    const target = relevantExportTarget(candidate)
    if (target) return target
  }
  return undefined
}

function authoredTargetCandidates(packageDir, target) {
  if (typeof target !== "string" || !target.startsWith("./")) return []
  const packageRelative = target.slice(2)
  const authored = packageRelative
    .replace(/^dist\//, "src/")
    .replace(/\.d\.(?:mts|cts|ts)$/, ".ts")
    .replace(/\.(?:mjs|cjs|js)$/, ".ts")
  const stem = authored.replace(/\.(?:mts|cts|tsx|ts)$/, "")
  return [...new Set([authored, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`])].map(
    (path) => posix.normalize(posix.join(packageDir, path)),
  )
}

function normalizePath(path) {
  return posix.normalize(path.replaceAll("\\", "/").replace(/^\.\//, ""))
}

const virtualProgramCache = new Map()

function virtualProgram(files, packages = []) {
  const cacheKey = JSON.stringify([files, packages])
  const cached = virtualProgramCache.get(cacheKey)
  if (cached) return cached
  const root = "/fixture"
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, source]) => [`${root}/${normalizePath(path)}`, source]),
  )
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    skipLibCheck: true,
    strict: true,
  }
  const defaultHost = ts.createCompilerHost(options)
  const workspaceModules = new Map()
  for (const { dir, packageJson } of packages) {
    for (const subpath of manifestExportSubpaths(packageJson.exports)) {
      const target = relevantExportTarget(exportValueAtSubpath(packageJson.exports, subpath))
      const sourcePath = authoredTargetCandidates(dir, target).find((candidate) =>
        normalizedFiles.has(`${root}/${normalizePath(candidate)}`),
      )
      if (!sourcePath) continue
      const specifier =
        subpath === "." ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`
      workspaceModules.set(specifier, `${root}/${normalizePath(sourcePath)}`)
    }
  }
  const host = {
    ...defaultHost,
    fileExists(path) {
      return normalizedFiles.has(normalizePath(path)) || defaultHost.fileExists(path)
    },
    getCurrentDirectory() {
      return root
    },
    getSourceFile(path, languageVersion) {
      const source = normalizedFiles.get(normalizePath(path))
      if (source !== undefined) {
        return ts.createSourceFile(path, source, languageVersion, true)
      }
      return defaultHost.getSourceFile(path, languageVersion)
    },
    readFile(path) {
      return normalizedFiles.get(normalizePath(path)) ?? defaultHost.readFile(path)
    },
    resolveModuleNames(moduleNames, containingFile) {
      return moduleNames.map((moduleName) => {
        const workspacePath = workspaceModules.get(moduleName)
        if (workspacePath) {
          return {
            resolvedFileName: workspacePath,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          }
        }
        if (moduleName.startsWith(".")) {
          const base = posix.resolve(posix.dirname(containingFile), moduleName)
          const candidates = [
            base,
            base.replace(/\.(?:mjs|cjs|js)$/, ".ts"),
            `${base}.ts`,
            posix.join(base, "index.ts"),
          ]
          const resolvedFileName = candidates.find((candidate) =>
            normalizedFiles.has(normalizePath(candidate)),
          )
          if (resolvedFileName) {
            return {
              resolvedFileName,
              extension: ts.Extension.Ts,
              isExternalLibraryImport: false,
            }
          }
        }
        return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule
      })
    },
  }
  const rootNames = [...normalizedFiles.keys()].filter((path) => /\.[cm]?tsx?$/.test(path))
  const program = ts.createProgram(rootNames, options, host)
  const result = {
    checker: program.getTypeChecker(),
    getSourceFile(path) {
      return program.getSourceFile(`${root}/${normalizePath(path)}`)
    },
  }
  virtualProgramCache.set(cacheKey, result)
  return result
}

function normalizePrinted(value) {
  const sourceFile = ts.createSourceFile(
    "/fingerprint.ts",
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const tokens = []
  const visit = (node) => {
    const children = node.getChildren(sourceFile)
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    const text = node.getText(sourceFile)
    if (
      text &&
      node.kind !== ts.SyntaxKind.EndOfFileToken &&
      node.kind !== ts.SyntaxKind.SemicolonToken
    ) {
      if (ts.isNumericLiteral(node)) {
        tokens.push(node.text)
      } else if (node.kind === ts.SyntaxKind.BigIntLiteral) {
        const bigintText = text.slice(0, -1).replaceAll("_", "")
        try {
          tokens.push(`${BigInt(bigintText).toString()}n`)
        } catch {
          tokens.push(text)
        }
      } else if (
        node.kind === ts.SyntaxKind.TemplateHead ||
        node.kind === ts.SyntaxKind.TemplateMiddle ||
        node.kind === ts.SyntaxKind.TemplateTail
      ) {
        if (typeof node.text !== "string") {
          tokens.push(text)
          return
        }
        const cooked = JSON.stringify(node.text)
          .slice(1, -1)
          .replaceAll("`", "\\`")
          .replaceAll("${", "\\${")
        tokens.push(
          node.kind === ts.SyntaxKind.TemplateHead
            ? `\`${cooked}\${`
            : node.kind === ts.SyntaxKind.TemplateMiddle
              ? `}${cooked}\${`
              : `}${cooked}\``,
        )
      } else {
        tokens.push(ts.isStringLiteralLike(node) ? JSON.stringify(node.text) : text)
      }
    }
  }
  visit(sourceFile)
  return tokens.join(" ")
}

function printed(node, sourceFile) {
  return normalizePrinted(node.getText(sourceFile))
}

function modifier(node, kind) {
  return node.modifiers?.some((candidate) => candidate.kind === kind) ?? false
}

function declarationName(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined
}

function typeParametersFingerprint(typeParameters, sourceFile) {
  return (typeParameters ?? []).map((parameter) => ({
    const: modifier(parameter, ts.SyntaxKind.ConstKeyword),
    name: parameter.name.text,
    constraint: parameter.constraint ? printed(parameter.constraint, sourceFile) : null,
    default: parameter.default ? printed(parameter.default, sourceFile) : null,
  }))
}

function checkerType(checker, node, explicitType) {
  if (explicitType) return printed(explicitType, node.getSourceFile())
  const type = checker.getTypeAtLocation(node)
  if (type.flags & ts.TypeFlags.Any && type.intrinsicName === "error") return null
  return normalizePrinted(checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation))
}

function propertyFingerprint(member, sourceFile, checker) {
  if (
    ts.isMethodSignature(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member) ||
    ts.isCallSignatureDeclaration(member) ||
    ts.isConstructSignatureDeclaration(member) ||
    ts.isIndexSignatureDeclaration(member)
  ) {
    const publicName = member.name
      ? printed(member.name, sourceFile)
      : ts.isCallSignatureDeclaration(member)
        ? "[[call]]"
        : ts.isConstructSignatureDeclaration(member)
          ? "[[construct]]"
          : "[[index]]"
    return callableFingerprint(member, publicName, checker)
  }
  if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) {
    return {
      kind: ts.SyntaxKind[member.kind],
      text: printed(member, sourceFile),
    }
  }
  return {
    kind: "property",
    name: printed(member.name, sourceFile),
    static: modifier(member, ts.SyntaxKind.StaticKeyword),
    readonly: modifier(member, ts.SyntaxKind.ReadonlyKeyword),
    optional: Boolean(member.questionToken),
    type: checkerType(checker, member, member.type),
  }
}

function callableFingerprint(declaration, publicName, checker) {
  const sourceFile = declaration.getSourceFile()
  const signature = checker.getSignatureFromDeclaration(declaration)
  return {
    kind:
      ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)
        ? "method"
        : ts.isGetAccessorDeclaration(declaration)
          ? "getter"
          : ts.isSetAccessorDeclaration(declaration)
            ? "setter"
            : ts.isCallSignatureDeclaration(declaration)
              ? "call"
              : ts.isConstructSignatureDeclaration(declaration)
                ? "construct"
                : ts.isIndexSignatureDeclaration(declaration)
                  ? "index"
                  : "function",
    name: publicName,
    static: modifier(declaration, ts.SyntaxKind.StaticKeyword),
    readonly: modifier(declaration, ts.SyntaxKind.ReadonlyKeyword),
    abstract: modifier(declaration, ts.SyntaxKind.AbstractKeyword),
    optional: Boolean(declaration.questionToken),
    typeParameters: typeParametersFingerprint(declaration.typeParameters, sourceFile),
    parameters: declaration.parameters.map((parameter) => ({
      name: printed(parameter.name, sourceFile),
      type: checkerType(checker, parameter, parameter.type),
      optional: Boolean(parameter.questionToken || parameter.initializer),
      rest: Boolean(parameter.dotDotDotToken),
    })),
    returnType: declaration.type
      ? printed(declaration.type, sourceFile)
      : signature
        ? normalizePrinted(
            checker.typeToString(
              checker.getReturnTypeOfSignature(signature),
              declaration,
              ts.TypeFormatFlags.NoTruncation,
            ),
          )
        : null,
  }
}

function interfaceCallableIdentity(member, fingerprint) {
  if (
    !ts.isMethodSignature(member) &&
    !ts.isMethodDeclaration(member) &&
    !ts.isGetAccessorDeclaration(member) &&
    !ts.isSetAccessorDeclaration(member) &&
    !ts.isCallSignatureDeclaration(member) &&
    !ts.isConstructSignatureDeclaration(member) &&
    !ts.isIndexSignatureDeclaration(member)
  ) {
    return null
  }
  const access = modifier(member, ts.SyntaxKind.PrivateKeyword)
    ? "private"
    : modifier(member, ts.SyntaxKind.ProtectedKeyword)
      ? "protected"
      : "public"
  const indexParameter = ts.isIndexSignatureDeclaration(member)
    ? fingerprint.parameters[0]?.type
    : null
  return [fingerprint.kind, fingerprint.name, fingerprint.static, access, indexParameter].join(":")
}

function containingInterfaceDeclaration(node) {
  let current = node
  while (current && !ts.isInterfaceDeclaration(current)) current = current.parent
  return current
}

function isSpecializedInterfaceSignature(signature) {
  return Boolean(
    signature.declaration?.parameters?.some(
      (parameter) => parameter.type && ts.isLiteralTypeNode(parameter.type),
    ),
  )
}

function effectiveInterfaceSignatures(signatures, members, declarations) {
  const memberSet = new Set(members)
  const declarationRanks = new Map(declarations.map((declaration, index) => [declaration, index]))
  const groups = new Map()
  for (const signature of signatures) {
    if (!signature.declaration || !memberSet.has(signature.declaration)) continue
    const interfaceDeclaration = containingInterfaceDeclaration(signature.declaration)
    const rank = declarationRanks.get(interfaceDeclaration)
    if (rank === undefined) return null
    const group = groups.get(rank) ?? []
    group.push(signature)
    groups.set(rank, group)
  }
  const specialized = signatures.filter(
    (signature) =>
      memberSet.has(signature.declaration) && isSpecializedInterfaceSignature(signature),
  )
  const ordinary = [...groups.entries()]
    .sort(([left], [right]) => right - left)
    .flatMap(([, group]) => group)
    .filter((signature) => !isSpecializedInterfaceSignature(signature))
  if (specialized.length + ordinary.length !== members.length) return null
  return [...specialized, ...ordinary]
}

function interfaceCheckerCallables(members, declarations, checker) {
  const first = members[0]
  if (!first) return null
  let signatures
  if (ts.isMethodSignature(first)) {
    const symbol = checker.getSymbolAtLocation(first.name)
    if (!symbol) return null
    signatures = checker.getSignaturesOfType(
      checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(symbol, first)),
      ts.SignatureKind.Call,
    )
  } else {
    const interfaceSymbol = checker.getSymbolAtLocation(declarations[0]?.name)
    if (!interfaceSymbol) return null
    const declaredType = checker.getDeclaredTypeOfSymbol(interfaceSymbol)
    signatures = checker.getSignaturesOfType(
      declaredType,
      ts.isConstructSignatureDeclaration(first)
        ? ts.SignatureKind.Construct
        : ts.SignatureKind.Call,
    )
  }
  const effective = effectiveInterfaceSignatures(signatures, members, declarations)
  if (!effective) return null
  const publicName = ts.isMethodSignature(first)
    ? printed(first.name, first.getSourceFile())
    : ts.isConstructSignatureDeclaration(first)
      ? "[[construct]]"
      : "[[call]]"
  return effective.map((signature) =>
    callableFingerprint(signature.declaration, publicName, checker),
  )
}

function isPublicClassMember(member) {
  return (
    !ts.isConstructorDeclaration(member) &&
    !ts.isClassStaticBlockDeclaration(member) &&
    !ts.isSemicolonClassElement(member) &&
    !(member.name && ts.isPrivateIdentifier(member.name)) &&
    !modifier(member, ts.SyntaxKind.PrivateKeyword) &&
    !modifier(member, ts.SyntaxKind.ProtectedKeyword)
  )
}

function publicClassFingerprints(declaration, checker) {
  const sourceFile = declaration.getSourceFile()
  const implementationConstructor = declaration.members.find(
    (member) => ts.isConstructorDeclaration(member) && member.body,
  )
  const callableGroups = new Map()
  for (const member of declaration.members) {
    if (
      !ts.isMethodDeclaration(member) &&
      !ts.isGetAccessorDeclaration(member) &&
      !ts.isSetAccessorDeclaration(member)
    ) {
      continue
    }
    const kind = ts.isGetAccessorDeclaration(member)
      ? "getter"
      : ts.isSetAccessorDeclaration(member)
        ? "setter"
        : "method"
    const key = `${kind}:${modifier(member, ts.SyntaxKind.StaticKeyword)}:${printed(member.name, sourceFile)}`
    const group = callableGroups.get(key) ?? []
    group.push(member)
    callableGroups.set(key, group)
  }
  const selectedCallables = new Set(
    [...callableGroups.values()].flatMap((group) => {
      const signatures = group.filter((member) => !member.body)
      return signatures.length > 0 ? signatures : group
    }),
  )
  return declaration.members.flatMap((member) => {
    if (ts.isConstructorDeclaration(member)) {
      if (implementationConstructor && member !== implementationConstructor) return []
      return member.parameters
        .filter(
          (parameter) =>
            parameter.modifiers?.some((candidate) =>
              [
                ts.SyntaxKind.PublicKeyword,
                ts.SyntaxKind.ReadonlyKeyword,
                ts.SyntaxKind.OverrideKeyword,
              ].includes(candidate.kind),
            ) &&
            !modifier(parameter, ts.SyntaxKind.PrivateKeyword) &&
            !modifier(parameter, ts.SyntaxKind.ProtectedKeyword),
        )
        .map((parameter) => ({
          kind: "property",
          name: printed(parameter.name, sourceFile),
          static: false,
          readonly: modifier(parameter, ts.SyntaxKind.ReadonlyKeyword),
          optional: Boolean(parameter.questionToken),
          type: checkerType(checker, parameter, parameter.type),
        }))
    }
    if (
      (ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)) &&
      !selectedCallables.has(member)
    ) {
      return []
    }
    return isPublicClassMember(member) ? [propertyFingerprint(member, sourceFile, checker)] : []
  })
}

function constructorFingerprint(declaration, checker) {
  const sourceFile = declaration.getSourceFile()
  return {
    kind: "constructor",
    access: modifier(declaration, ts.SyntaxKind.PrivateKeyword)
      ? "private"
      : modifier(declaration, ts.SyntaxKind.ProtectedKeyword)
        ? "protected"
        : "public",
    typeParameters: typeParametersFingerprint(declaration.typeParameters, sourceFile),
    parameters: declaration.parameters.map((parameter) => ({
      name: printed(parameter.name, sourceFile),
      type: checkerType(checker, parameter, parameter.type),
      optional: Boolean(parameter.questionToken || parameter.initializer),
      rest: Boolean(parameter.dotDotDotToken),
    })),
  }
}

function declarationsFingerprint(declarations, publicName, checker) {
  const callableDeclarations = declarations.filter(
    (declaration) => ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration),
  )
  if (callableDeclarations.length > 0) {
    if (callableDeclarations.length !== declarations.length) return null
    const signatures = callableDeclarations.some((declaration) => !declaration.body)
      ? callableDeclarations.filter((declaration) => !declaration.body)
      : callableDeclarations
    return signatures.map((declaration) => callableFingerprint(declaration, publicName, checker))
  }

  if (declarations.length > 0 && declarations.every(ts.isInterfaceDeclaration)) {
    const typeParameters = declarations.map((declaration) =>
      typeParametersFingerprint(declaration.typeParameters, declaration.getSourceFile()),
    )
    if (
      typeParameters.some(
        (candidate) => JSON.stringify(candidate) !== JSON.stringify(typeParameters[0]),
      )
    ) {
      return null
    }
    const heritage = [
      ...new Set(
        declarations.flatMap((declaration) =>
          (declaration.heritageClauses ?? []).flatMap((clause) =>
            clause.types.map((type) => printed(type, declaration.getSourceFile())),
          ),
        ),
      ),
    ].sort()
    const properties = []
    const structuralMembers = new Map()
    const callableGroups = new Map()
    const checkerCallableGroups = new Map()
    const namedKinds = new Map()
    const propertiesByName = new Map()
    for (const declaration of declarations) {
      for (const member of declaration.members) {
        const fingerprint = propertyFingerprint(member, declaration.getSourceFile(), checker)
        const serialized = JSON.stringify(fingerprint)
        const memberName = fingerprint.name
        if (typeof memberName === "string") {
          const kind = fingerprint.kind === "property" ? "property" : "callable"
          const existingKind = namedKinds.get(memberName)
          if (existingKind && existingKind !== kind) return null
          namedKinds.set(memberName, kind)
          if (fingerprint.kind === "property") {
            const existing = propertiesByName.get(memberName)
            if (existing && existing !== serialized) return null
            propertiesByName.set(memberName, serialized)
          }
        }
        const callableIdentity = interfaceCallableIdentity(member, fingerprint)
        if (callableIdentity) {
          if (
            ts.isMethodSignature(member) ||
            ts.isCallSignatureDeclaration(member) ||
            ts.isConstructSignatureDeclaration(member)
          ) {
            const group = checkerCallableGroups.get(callableIdentity) ?? []
            group.push(member)
            checkerCallableGroups.set(callableIdentity, group)
          } else {
            const group = callableGroups.get(callableIdentity) ?? []
            group.push(fingerprint)
            callableGroups.set(callableIdentity, group)
          }
        } else if (fingerprint.kind === "property") {
          if (!properties.some((candidate) => JSON.stringify(candidate) === serialized)) {
            properties.push(fingerprint)
          }
        } else {
          structuralMembers.set(serialized, fingerprint)
        }
      }
    }
    properties.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    const checkerCallables = []
    for (const [, members] of [...checkerCallableGroups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const fingerprints = interfaceCheckerCallables(members, declarations, checker)
      if (!fingerprints) return null
      checkerCallables.push(...fingerprints)
    }
    const fields = [
      ...properties,
      ...[...structuralMembers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, fingerprint]) => fingerprint),
      ...[...callableGroups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, fingerprints]) => fingerprints),
      ...checkerCallables,
    ]
    return {
      kind: "interface",
      name: publicName,
      typeParameters: typeParameters[0] ?? [],
      heritage,
      fields,
    }
  }

  if (declarations.length > 1) return null

  const declaration = declarations[0]
  if (!declaration) return null
  const sourceFile = declaration.getSourceFile()
  if (ts.isTypeAliasDeclaration(declaration)) {
    return {
      kind: "type",
      name: publicName,
      typeParameters: typeParametersFingerprint(declaration.typeParameters, sourceFile),
      type: printed(declaration.type, sourceFile),
    }
  }
  if (ts.isVariableDeclaration(declaration)) {
    return {
      kind: "object",
      name: publicName,
      constant: Boolean(declaration.parent.flags & ts.NodeFlags.Const),
      type: checkerType(checker, declaration, declaration.type),
    }
  }
  if (ts.isClassDeclaration(declaration)) {
    return {
      kind: "class",
      name: publicName,
      abstract: modifier(declaration, ts.SyntaxKind.AbstractKeyword),
      typeParameters: typeParametersFingerprint(declaration.typeParameters, sourceFile),
      heritage: (declaration.heritageClauses ?? []).map((clause) => printed(clause, sourceFile)),
      constructors: (() => {
        const constructors = declaration.members.filter(ts.isConstructorDeclaration)
        const signatures = constructors.some((candidate) => !candidate.body)
          ? constructors.filter((candidate) => !candidate.body)
          : constructors
        return signatures.map((candidate) => constructorFingerprint(candidate, checker))
      })(),
      fields: publicClassFingerprints(declaration, checker),
    }
  }
  if (ts.isEnumDeclaration(declaration) || ts.isModuleDeclaration(declaration)) return null
  return {
    kind: ts.SyntaxKind[declaration.kind],
    name: publicName,
    text: printed(declaration, sourceFile),
  }
}

function resolveAliasedSymbol(symbol, checker) {
  let current = symbol
  const seen = new Set()
  while (current && current.flags & ts.SymbolFlags.Alias && !seen.has(current)) {
    seen.add(current)
    current = checker.getAliasedSymbol(current)
  }
  return current
}

function moduleInventory(program, sourcePath) {
  const sourceFile = program.getSourceFile(sourcePath)
  if (!sourceFile) return { sourceFile: null, exports: new Map() }
  const moduleSymbol = program.checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) return { sourceFile, exports: new Map() }
  const exports = new Map()
  for (const publicSymbol of program.checker.getExportsOfModule(moduleSymbol)) {
    const name = String(publicSymbol.escapedName)
    const target = resolveAliasedSymbol(publicSymbol, program.checker)
    exports.set(name, {
      fingerprint: declarationsFingerprint(target?.declarations ?? [], name, program.checker),
      declarations: target?.declarations ?? [],
    })
  }
  return { sourceFile, exports }
}

function maskText(value) {
  return value.replace(/[^\r\n]/g, " ")
}

function maskMdx(source, { comments = true, fences = true } = {}) {
  const characters = source.split("")
  if (comments) {
    for (const pattern of [/<!--[\s\S]*?(?:-->|$)/g, /\{\/\*[\s\S]*?(?:\*\/\}|$)/g]) {
      for (const match of source.matchAll(pattern)) {
        const start = match.index ?? 0
        const replacement = maskText(match[0])
        characters.splice(start, match[0].length, ...replacement)
      }
    }
  }
  if (fences) {
    const current = characters.join("")
    const lines = current.match(/.*(?:\r?\n|$)/g) ?? []
    let offset = 0
    let open = null
    for (const line of lines) {
      const content = line.replace(/\r?\n$/, "")
      if (open) {
        const close = /^[ \t]{0,3}([`~]+)[ \t]*$/.exec(content)?.[1]
        const shouldClose = close && close[0] === open.character && close.length >= open.length
        const replacement = maskText(line)
        characters.splice(offset, line.length, ...replacement)
        if (shouldClose) open = null
      } else {
        const run = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(content)?.[1]
        if (run) {
          open = { character: run[0], length: run.length }
          const replacement = maskText(line)
          characters.splice(offset, line.length, ...replacement)
        }
      }
      offset += line.length
    }
  }
  return characters.join("")
}

function protectCodeSpans(value) {
  const protectedValues = []
  const text = replaceInlineCodeSpans(value, (_match, content) => {
    const token = `\u0000${protectedValues.length}\u0000`
    protectedValues.push(content.trim())
    return token
  })
  return { protectedValues, text }
}

function replaceInlineCodeSpans(value, replace) {
  const runs = [...value.matchAll(/`+/g)]
  let result = ""
  let cursor = 0
  for (let openerIndex = 0; openerIndex < runs.length; openerIndex++) {
    const opener = runs[openerIndex]
    const closerIndex = runs.findIndex(
      (candidate, index) => index > openerIndex && candidate[0].length === opener[0].length,
    )
    if (closerIndex === -1) continue
    const closer = runs[closerIndex]
    const start = opener.index ?? 0
    const end = (closer.index ?? 0) + closer[0].length
    result += value.slice(cursor, start)
    result += replace(value.slice(start, end), value.slice(start + opener[0].length, closer.index))
    cursor = end
    openerIndex = closerIndex
  }
  return result + value.slice(cursor)
}

function renderedInline(value) {
  const { protectedValues, text } = protectCodeSpans(value)
  let rendered = text
    .replace(AUTOLINK_PATTERN, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
  for (const [index, code] of protectedValues.entries()) {
    rendered = rendered.replace(`\u0000${index}\u0000`, code)
  }
  return rendered.replace(/\s+/g, " ").trim()
}

function stripMdxTags(source) {
  const protectedSpans = []
  const protectedSource = replaceInlineCodeSpans(source, (match) => {
    const token = `\u0000inline-code-${protectedSpans.length}\u0000`
    protectedSpans.push(match)
    return token
  })
  const characters = protectedSource.split("")
  for (let index = 0; index < protectedSource.length; index++) {
    AUTOLINK_PATTERN.lastIndex = 0
    const autolink = AUTOLINK_PATTERN.exec(protectedSource.slice(index))
    if (autolink?.index === 0) {
      index += autolink[0].length - 1
      continue
    }
    if (protectedSource[index] !== "<" || !/^\/?[A-Za-z]/.test(protectedSource.slice(index + 1))) {
      continue
    }
    let quote = null
    let escaped = false
    let braces = 0
    let end = index + 1
    for (; end < protectedSource.length; end++) {
      const character = protectedSource[end]
      if (quote) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        continue
      }
      if (character === "{") {
        braces++
        continue
      }
      if (character === "}" && braces > 0) {
        braces--
        continue
      }
      if (character === ">" && braces === 0) break
    }
    if (end >= protectedSource.length) continue
    const replacement = maskText(protectedSource.slice(index, end + 1))
    characters.splice(index, replacement.length, ...replacement)
    index = end
  }
  let stripped = characters.join("")
  for (const [index, span] of protectedSpans.entries()) {
    stripped = stripped.replace(`\u0000inline-code-${index}\u0000`, span)
  }
  return stripped
}

function headingsFromDocument(source) {
  const visible = maskMdx(source)
  const originalLines = source.split(/\r?\n/)
  const visibleLines = visible.split(/\r?\n/)
  const headings = []
  for (const [index, line] of visibleLines.entries()) {
    const match = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
    if (!match) continue
    const original = originalLines[index] ?? line
    const raw = original.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, "").replace(/[ \t]+#+[ \t]*$/, "")
    headings.push({ index, level: match[1].length, text: renderedInline(raw) })
  }
  return headings
}

function packageAddress(heading) {
  const match = /^(@[^/]+\/[^/]+)(?:\/(.+))?$/.exec(heading)
  if (!match) return null
  return { packageName: match[1], subpath: match[2] ? `./${match[2]}` : "." }
}

function tableCells(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null
  const cells = []
  let cell = ""
  let codeDelimiter = 0
  const content = trimmed.slice(1, -1)
  for (let index = 0; index < content.length; index++) {
    const character = content[index]
    if (character === "`") {
      let end = index + 1
      while (content[end] === "`") end++
      const length = end - index
      if (codeDelimiter === 0) codeDelimiter = length
      else if (codeDelimiter === length) codeDelimiter = 0
      cell += content.slice(index, end)
      index = end - 1
      continue
    }
    if (character === "|") {
      let escapes = 0
      for (let before = index - 1; before >= 0 && content[before] === "\\"; before--) escapes++
      if (codeDelimiter === 0 && escapes % 2 === 0) {
        cells.push(cell.trim())
        cell = ""
        continue
      }
      cell = escapes % 2 === 1 ? `${cell.slice(0, -1)}|` : `${cell}|`
      continue
    }
    cell += character
  }
  cells.push(cell.trim())
  return cells
}

function uncode(value) {
  const match = /^`([^`]+)`$/.exec(value.trim())
  return match ? match[1] : renderedInline(value)
}

function ownershipRowsFromDocument(document) {
  const visibleLines = maskMdx(document.source).split(/\r?\n/)
  const rows = []
  let section = null
  for (let index = 0; index < visibleLines.length; index++) {
    const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(visibleLines[index])
    if (heading) {
      if (heading[1].length <= 3) section = null
      if (heading[1].length === 3) {
        const text = renderedInline(heading[2])
        section = { address: packageAddress(text), heading: text }
      }
      continue
    }
    if (!section || visibleLines[index].trim() !== "| Export | Responsibility |") continue
    const separator = tableCells(visibleLines[index + 1] ?? "")
    if (separator?.length !== 2 || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
      continue
    }
    index += 2
    while (index < visibleLines.length) {
      const cells = tableCells(visibleLines[index])
      if (cells?.length !== 2) break
      const symbol = /^`([^`]+)`$/.exec(cells[0])?.[1]
      if (symbol && renderedInline(cells[1])) {
        rows.push({
          ...(section.address ?? { packageName: null, subpath: null }),
          heading: section.heading,
          symbol,
          href: document.href,
          path: document.path,
        })
      }
      index++
    }
    index--
  }
  return rows
}

function generatedOwnershipRowsFromDocument(document) {
  const visibleLines = maskMdx(document.source).split(/\r?\n/)
  const rows = []
  let moduleName = null
  for (let index = 0; index < visibleLines.length; index++) {
    const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(visibleLines[index])
    if (heading) {
      if (heading[1].length <= 3) moduleName = null
      if (heading[1].length === 3) moduleName = renderedInline(heading[2])
      continue
    }
    if (!moduleName || visibleLines[index].trim() !== "| Generated export | Responsibility |") {
      continue
    }
    const separator = tableCells(visibleLines[index + 1] ?? "")
    if (separator?.length !== 2 || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
      continue
    }
    index += 2
    while (index < visibleLines.length) {
      const cells = tableCells(visibleLines[index])
      if (cells?.length !== 2) break
      const symbol = /^`([^`]+)`$/.exec(cells[0])?.[1]
      if (symbol && renderedInline(cells[1])) {
        rows.push({ moduleName, symbol, href: document.href, path: document.path })
      }
      index++
    }
    index--
  }
  return rows
}

function hasReservedApiContractMetadata(info) {
  let index = 0
  while (index < info.length && !/\s/.test(info[index])) index++
  while (index < info.length) {
    while (/\s/.test(info[index])) index++
    if (index >= info.length) break
    if (info[index] === '"' || info[index] === "'") {
      const quote = info[index++]
      while (index < info.length) {
        if (info[index] === "\\") index += 2
        else if (info[index++] === quote) break
      }
      continue
    }
    const keyStart = index
    while (index < info.length && !/[\s='"]/.test(info[index])) index++
    const key = info.slice(keyStart, index)
    if (/^[{[(,]*api-contract(?=$|[^A-Za-z0-9_$-])/.test(key)) return true
    while (/\s/.test(info[index])) index++
    if (info[index] !== "=") continue
    index++
    while (/\s/.test(info[index])) index++
    if (info[index] === '"' || info[index] === "'") {
      const quote = info[index++]
      while (index < info.length) {
        if (info[index] === "\\") index += 2
        else if (info[index++] === quote) break
      }
    } else {
      while (index < info.length && !/\s/.test(info[index])) index++
    }
  }
  return false
}

function contractFencesFromDocument(document) {
  const source = maskMdx(document.source, { comments: true, fences: false })
  const lines = source.split(/\r?\n/)
  const contracts = []
  let open = null
  for (let index = 0; index < lines.length; index++) {
    if (open) {
      const close = /^[ \t]{0,3}([`~]+)[ \t]*$/.exec(lines[index])?.[1]
      if (close && close[0] === open.character && close.length >= open.length) {
        if (open.key) {
          contracts.push({
            key: open.key,
            source: open.body.join("\n"),
            href: document.href,
            path: document.path,
          })
        } else if (open.invalidTag) {
          contracts.push({
            invalidTag: open.info,
            href: document.href,
            path: document.path,
          })
        }
        open = null
      } else if (open.key) {
        open.body.push(lines[index])
      }
      continue
    }

    const opening = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/.exec(lines[index])
    if (!opening) continue
    const info = opening[3].trim()
    const contract =
      opening[1] === "" && opening[2] === "```"
        ? /^ts api-contract="([^"]+)"[ \t]*$/.exec(opening[3])
        : null
    open = {
      character: opening[2][0],
      length: opening[2].length,
      key: contract?.[1] ?? null,
      info,
      invalidTag: hasReservedApiContractMetadata(info) && !contract,
      body: [],
    }
  }
  if (open?.key || open?.invalidTag) {
    contracts.push({
      invalidTag: open.info,
      href: document.href,
      path: document.path,
    })
  }
  return contracts
}

function fieldTablesFromDocument(document) {
  const lines = maskMdx(document.source).split(/\r?\n/)
  const tables = []
  for (let index = 0; index < lines.length; index++) {
    const caption = /^\*\*Fields: `([^`]+)`\*\*[ \t]*$/.exec(lines[index])
    const exactHeader = "| Field | Type | Required | Description |"
    if (/^[ \t]*\*\*Fields\b/.test(lines[index]) && !caption) {
      tables.push({ invalidCaption: lines[index].trim(), href: document.href, path: document.path })
      continue
    }
    if (!caption) continue
    if (lines[index + 1]?.trim() !== exactHeader) {
      tables.push({
        key: caption[1],
        invalidStructure: "header",
        href: document.href,
        path: document.path,
      })
      continue
    }
    const separator = tableCells(lines[index + 2] ?? "")
    if (separator?.length !== 4 || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
      tables.push({
        key: caption[1],
        invalidStructure: "separator",
        href: document.href,
        path: document.path,
      })
      continue
    }
    const fields = []
    let malformedRow = false
    index += 3
    while (index < lines.length) {
      if (!lines[index].trim().startsWith("|")) break
      const cells = tableCells(lines[index])
      if (cells?.length !== 4) {
        malformedRow = true
        index++
        continue
      }
      const field = /^`(?:(readonly) )?([A-Za-z_$][\w$]*)`$/.exec(cells[0])
      const type = /^`([^`]+)`$/.exec(cells[1])
      const required = cells[2].toLowerCase()
      if (!field || !type || !["yes", "no"].includes(required) || !renderedInline(cells[3])) {
        malformedRow = true
      }
      fields.push({
        name: field?.[2] ?? uncode(cells[0]),
        readonly: Boolean(field?.[1]),
        type: type?.[1] ?? uncode(cells[1]),
        required,
        validName: Boolean(field),
      })
      index++
    }
    tables.push(
      fields.length === 0 || malformedRow
        ? {
            key: caption[1],
            invalidStructure: "row",
            href: document.href,
            path: document.path,
          }
        : {
            key: caption[1],
            fields,
            href: document.href,
            path: document.path,
          },
    )
    index--
  }
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "| Field | Type | Required | Description |") continue
    const previous = lines[index - 1] ?? ""
    if (!/^\*\*Fields: `([^`]+)`\*\*[ \t]*$/.test(previous)) {
      tables.push({ missingCaption: true, href: document.href, path: document.path })
    }
  }
  return tables
}

function parseContractKey(key) {
  const match = /^(.+)#(\.|\.\/[^:]+):([^:]+)$/.exec(key)
  return match ? { packageName: match[1], subpath: match[2], symbol: match[3] } : null
}

const contractFingerprintCache = new Map()

function contractFingerprint(contract, symbol) {
  const cacheKey = `${symbol}\u0000${contract}`
  if (contractFingerprintCache.has(cacheKey)) return contractFingerprintCache.get(cacheKey)
  const contractProgram = virtualProgram({ "contract.ts": contract })
  const sourceFile = contractProgram.getSourceFile("contract.ts")
  if (!sourceFile || sourceFile.parseDiagnostics.length > 0) {
    contractFingerprintCache.set(cacheKey, null)
    return null
  }
  const declarations = []
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      declarationName(statement) === symbol
    ) {
      declarations.push(statement)
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declarationName(declaration) === symbol) declarations.push(declaration)
      }
    }
  }
  const fingerprint = declarationsFingerprint(declarations, symbol, contractProgram.checker)
  contractFingerprintCache.set(cacheKey, fingerprint)
  return fingerprint
}

function exportedProperties(exportInfo, checker) {
  const declarations = exportInfo?.declarations.filter(
    (candidate) => ts.isInterfaceDeclaration(candidate) || ts.isClassDeclaration(candidate),
  )
  if (!declarations?.length) return null
  const properties = declarations.flatMap((declaration) => {
    const sourceFile = declaration.getSourceFile()
    return declaration.members
      .filter((member) => ts.isPropertySignature(member) || ts.isPropertyDeclaration(member))
      .map((member) => ({
        name: printed(member.name, sourceFile),
        type: checkerType(checker, member, member.type),
        required: member.questionToken ? "no" : "yes",
        readonly: modifier(member, ts.SyntaxKind.ReadonlyKeyword),
      }))
  })
  const byName = new Map()
  for (const property of properties) {
    const existing = byName.get(property.name)
    if (existing && JSON.stringify(existing) !== JSON.stringify(property)) return null
    byName.set(property.name, property)
  }
  return [...byName.values()]
}

function normalizeProse(value) {
  return value.replace(/\s+/g, " ").trim()
}

function maskEsmDeclarations(source) {
  const characters = source.split("")
  const candidates = [...source.matchAll(/^(?:import|export)\b/gm)]
  for (const candidate of candidates) {
    const start = candidate.index ?? 0
    const sourceFile = ts.createSourceFile(
      "/behavior-block.tsx",
      source.slice(start),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const statement = sourceFile.statements[0]
    if (!statement) continue
    const isEsm =
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      modifier(statement, ts.SyntaxKind.ExportKeyword)
    if (
      !isEsm ||
      sourceFile.parseDiagnostics.some(
        (diagnostic) => (diagnostic.start ?? Number.POSITIVE_INFINITY) < statement.end,
      )
    ) {
      continue
    }
    const declarationStart = start + statement.getStart(sourceFile)
    const declarationEnd = start + statement.end
    const replacement = maskText(source.slice(declarationStart, declarationEnd))
    characters.splice(declarationStart, replacement.length, ...replacement)
  }
  return characters.join("")
}

function maskNavigationOnlyMdx(source) {
  const protectedSpans = []
  let masked = replaceInlineCodeSpans(source, (match) => {
    const token = `\u0000inline-code-${protectedSpans.length}\u0000`
    protectedSpans.push(match)
    return token
  })
  for (const component of NAVIGATION_ONLY_MDX_COMPONENTS) {
    const pattern = new RegExp(
      `<${component}\\b[\\s\\S]*?(?:\\/>|>[\\s\\S]*?<\\/${component}\\s*>)`,
      "g",
    )
    masked = masked.replace(pattern, (match) => maskText(match))
  }
  for (const [index, span] of protectedSpans.entries()) {
    masked = masked.replace(`\u0000inline-code-${index}\u0000`, span)
  }
  return masked
}

function behaviorBlocks(document) {
  const headings = headingsFromDocument(document.source)
  const lines = document.source.split(/\r?\n/)
  const blocks = []
  for (const heading of headings) {
    if (heading.level !== 4) continue
    const id = /^Behavior contract (.+)$/.exec(heading.text)?.[1]
    if (!id) continue
    const next = headings.find(
      (candidate) => candidate.index > heading.index && candidate.level <= 4,
    )
    const end = next?.index ?? lines.length
    const blockLines = lines.slice(heading.index + 1, end)
    const firstLine = blockLines[0]?.trim() ?? ""
    const markerMatch = /^<!-- api-behavior-authorities: (\[[\s\S]*\]) -->$/.exec(firstLine)
    let identities = null
    if (markerMatch) {
      try {
        identities = JSON.parse(markerMatch[1])
      } catch {
        identities = null
      }
    }
    const proseSource = stripMdxTags(
      maskNavigationOnlyMdx(maskEsmDeclarations(maskMdx(blockLines.join("\n")))),
    )
    const proseLines = proseSource.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed || /^\|?\s*:?-{3,}/.test(trimmed)) {
        return []
      }
      const withoutHeading = trimmed.replace(/^#{5,6}\s+/, "")
      const withoutListMarker = withoutHeading.replace(/^(?:[-+*]|\d+\.)\s+/, "")
      const tableText = withoutListMarker.startsWith("|")
        ? (tableCells(withoutListMarker) ?? []).join(" ")
        : withoutListMarker
      const rendered = renderedInline(tableText)
      return rendered ? [rendered] : []
    })
    blocks.push({
      id,
      href: document.href,
      path: document.path,
      claim: normalizeProse(proseLines.join(" ")),
      identities,
      markerPresent: Boolean(markerMatch),
    })
  }
  return blocks
}

function authorityIdentity(authority) {
  if (authority.kind === "source-ast") {
    return {
      kind: authority.kind,
      file: authority.file,
      selector: authority.selector,
    }
  }
  return {
    kind: authority.kind,
    file: authority.file,
    testNames: authority.testNames,
  }
}

function fieldShapeMismatch(value, expectedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true
  const actualFields = Object.keys(value).sort()
  return JSON.stringify(actualFields) !== JSON.stringify([...expectedFields].sort())
}

function directNamedDeclarations(statements, name) {
  const matches = []
  for (const statement of statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      declarationName(statement) === name
    ) {
      matches.push(statement)
    }
    if (ts.isVariableStatement(statement)) {
      matches.push(
        ...statement.declarationList.declarations.filter(
          (declaration) => declarationName(declaration) === name,
        ),
      )
    }
  }
  return matches
}

function uniqueNamedDeclaration(statements, name) {
  const matches = directNamedDeclarations(statements, name)
  return matches.length === 1 ? matches[0] : null
}

function unwrapExpression(expression) {
  let current = expression
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function declarationMembers(declaration) {
  if (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration)
  ) {
    return [...declaration.members]
  }
  if (ts.isModuleDeclaration(declaration)) {
    let body = declaration.body
    while (body && ts.isModuleDeclaration(body)) body = body.body
    return body && ts.isModuleBlock(body) ? [...body.statements] : []
  }
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
    return initializer && ts.isObjectLiteralExpression(initializer)
      ? [...initializer.properties]
      : []
  }
  return []
}

function memberName(member, sourceFile) {
  if (ts.isVariableStatement(member)) return null
  return member.name ? printed(member.name, sourceFile) : null
}

function variableDeclarationFingerprint(declaration, sourceFile) {
  if (!ts.isVariableDeclarationList(declaration.parent)) return printed(declaration, sourceFile)
  const statement = declaration.parent.parent
  const flags = declaration.parent.flags
  const kind = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var"
  const modifiers = ts.isVariableStatement(statement)
    ? (statement.modifiers ?? [])
        .filter((candidate) =>
          [
            ts.SyntaxKind.ExportKeyword,
            ts.SyntaxKind.DefaultKeyword,
            ts.SyntaxKind.DeclareKeyword,
          ].includes(candidate.kind),
        )
        .map((candidate) => candidate.getText(sourceFile))
    : []
  return `${[...modifiers, kind].join(" ")} ${printed(declaration, sourceFile)};`
}

function sourceSelectorFingerprint(sourceFile, selector) {
  const branch = /^([A-Za-z_$][\w$]*)\.branch\[(\d+)\]$/.exec(selector)
  if (branch) {
    const declaration = uniqueNamedDeclaration(sourceFile.statements, branch[1])
    if (!declaration) return null
    const branches = []
    const visit = (node) => {
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isCaseClause(node)) {
        branches.push(node)
      }
      ts.forEachChild(node, visit)
    }
    const branchRoot = ts.isVariableDeclaration(declaration)
      ? unwrapExpression(declaration.initializer)
      : declaration
    if (!branchRoot) return null
    visit(branchRoot)
    const selected = branches[Number(branch[2])]
    return selected ? printed(selected, sourceFile) : null
  }

  const dot = selector.lastIndexOf(".")
  if (dot !== -1) {
    const ownerName = selector.slice(0, dot)
    const propertyName = selector.slice(dot + 1)
    const declaration = uniqueNamedDeclaration(sourceFile.statements, ownerName)
    if (!declaration) return null
    const members = declarationMembers(declaration)
    const matches = []
    for (const member of members) {
      if (ts.isVariableStatement(member)) {
        matches.push(
          ...member.declarationList.declarations.filter(
            (candidate) => declarationName(candidate) === propertyName,
          ),
        )
      } else if (memberName(member, sourceFile) === propertyName) {
        matches.push(member)
      }
    }
    if (matches.length !== 1) return null
    return ts.isVariableDeclaration(matches[0])
      ? variableDeclarationFingerprint(matches[0], sourceFile)
      : printed(matches[0], sourceFile)
  }

  const declaration = uniqueNamedDeclaration(sourceFile.statements, selector)
  if (!declaration) return null
  if (ts.isVariableDeclaration(declaration)) {
    return variableDeclarationFingerprint(declaration, sourceFile)
  }
  return printed(declaration, sourceFile)
}

function testAssertionFingerprint(sourceFile, testNames) {
  const assertionsByName = new Map()
  const isTestFactory = (expression) => {
    if (ts.isIdentifier(expression)) return expression.text === "test" || expression.text === "it"
    const eachTarget = ts.isCallExpression(expression)
      ? expression.expression
      : ts.isTaggedTemplateExpression(expression)
        ? expression.tag
        : null
    return (
      eachTarget &&
      ts.isPropertyAccessExpression(eachTarget) &&
      eachTarget.name.text === "each" &&
      ts.isIdentifier(eachTarget.expression) &&
      (eachTarget.expression.text === "test" || eachTarget.expression.text === "it")
    )
  }
  const hasExpectRoot = (expression) => {
    let current = expression
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression
    }
    if (!ts.isCallExpression(current)) return false
    if (ts.isIdentifier(current.expression)) return current.expression.text === "expect"
    return (
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "expect" &&
      current.expression.name.text === "poll"
    )
  }
  const visitTest = (node) => {
    if (
      ts.isCallExpression(node) &&
      isTestFactory(node.expression) &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const assertions = []
      const visitAssertion = (candidate) => {
        if (ts.isCallExpression(candidate) && hasExpectRoot(candidate.expression)) {
          const fingerprintNode = ts.isAwaitExpression(candidate.parent)
            ? candidate.parent
            : candidate
          assertions.push(printed(fingerprintNode, sourceFile))
          return
        }
        ts.forEachChild(candidate, visitAssertion)
      }
      for (const argument of node.arguments.slice(1)) visitAssertion(argument)
      const namedTests = assertionsByName.get(node.arguments[0].text) ?? []
      namedTests.push(assertions)
      assertionsByName.set(node.arguments[0].text, namedTests)
      return
    }
    ts.forEachChild(node, visitTest)
  }
  visitTest(sourceFile)
  const selected = []
  for (const name of testNames) {
    const matchingTests = assertionsByName.get(name)
    if (matchingTests?.length !== 1 || matchingTests[0].length === 0) return null
    selected.push(...matchingTests[0])
  }
  return selected.join("\n")
}

function validateBehaviorContracts(fixture, program, failures) {
  const blocks = fixture.documents.flatMap(behaviorBlocks)
  const blocksById = new Map()
  for (const block of blocks) {
    const matchingBlocks = blocksById.get(block.id) ?? []
    matchingBlocks.push(block)
    blocksById.set(block.id, matchingBlocks)
  }
  for (const [id, matchingBlocks] of blocksById) {
    if (matchingBlocks.length <= 1) continue
    const markerDetail = matchingBlocks.some((block) => !block.markerPresent)
      ? " with an authority marker omission"
      : ""
    failures.push(`duplicate behavior contract block id ${id}${markerDetail}`)
  }
  const contractIds = new Set()
  for (const contract of fixture.behaviorContracts ?? []) {
    if (fieldShapeMismatch(contract, ["id", "ownerHref", "claim", "authorities"])) {
      failures.push(`behavior contract ${String(contract?.id)} registry fields do not match schema`)
    }
    if (typeof contract.id !== "string" || contractIds.has(contract.id)) {
      failures.push(`behavior contract ${String(contract.id)} has an invalid or duplicate id`)
      continue
    }
    contractIds.add(contract.id)
    const matchingBlocks = blocksById.get(contract.id) ?? []
    if (matchingBlocks.length === 0) {
      failures.push(
        `behavior contract ${contract.id} is missing from owner page ${contract.ownerHref}`,
      )
      continue
    }
    if (typeof contract.claim !== "string" || normalizeProse(contract.claim) !== contract.claim) {
      failures.push(`behavior contract ${contract.id} registry claim is not exactly normalized`)
    }
    if (!Array.isArray(contract.authorities) || contract.authorities.length === 0) {
      failures.push(`behavior contract ${contract.id} requires a non-empty authorities tuple`)
      continue
    }
    for (const block of matchingBlocks) {
      if (block.href !== contract.ownerHref) {
        failures.push(
          `behavior contract ${contract.id} is authored outside owner page ${contract.ownerHref}: ${block.href}`,
        )
      }
      if (block.claim !== contract.claim) {
        failures.push(
          `behavior contract ${contract.id} claim mismatch on owner page ${block.href}: ${JSON.stringify(block.claim)}`,
        )
      }
      if (!block.markerPresent) {
        failures.push(
          `behavior contract ${contract.id} on owner page ${block.href} is missing its authority marker`,
        )
      } else if (
        JSON.stringify(block.identities) !==
        JSON.stringify(contract.authorities.map(authorityIdentity))
      ) {
        failures.push(
          `behavior contract ${contract.id} authority identity marker does not match registry on owner page ${block.href}`,
        )
      }
    }

    for (const authority of contract.authorities) {
      const expectedFields =
        authority.kind === "source-ast"
          ? ["kind", "file", "selector", "expected"]
          : authority.kind === "test-assertion"
            ? ["kind", "file", "testNames", "assertionFingerprint"]
            : []
      if (expectedFields.length === 0 || fieldShapeMismatch(authority, expectedFields)) {
        failures.push(
          `behavior contract ${contract.id} ${String(authority.kind)} authority registry fields do not match schema`,
        )
      }
      const sourceFile = program.getSourceFile(authority.file)
      if (!sourceFile) {
        failures.push(
          `behavior contract ${contract.id} ${authority.kind} authority file is missing: ${authority.file}`,
        )
        continue
      }
      if (authority.kind === "source-ast") {
        const actual = sourceSelectorFingerprint(sourceFile, authority.selector)
        if (actual === null || normalizePrinted(actual) !== normalizePrinted(authority.expected)) {
          failures.push(
            `behavior contract ${contract.id} source-ast ${authority.selector} fingerprint mismatch in ${authority.file}: expected ${JSON.stringify(authority.expected)}, received ${JSON.stringify(actual)}`,
          )
        }
      } else if (authority.kind === "test-assertion") {
        if (!Array.isArray(authority.testNames) || authority.testNames.length === 0) {
          failures.push(`behavior contract ${contract.id} test-assertion requires test names`)
          continue
        }
        const actual = testAssertionFingerprint(sourceFile, authority.testNames)
        if (
          actual === null ||
          normalizePrinted(actual) !== normalizePrinted(authority.assertionFingerprint)
        ) {
          failures.push(
            `behavior contract ${contract.id} test-assertion ${authority.testNames.join(", ")} expect fingerprint mismatch in ${authority.file}: expected ${JSON.stringify(authority.assertionFingerprint)}, received ${JSON.stringify(actual)}`,
          )
        }
      } else {
        failures.push(
          `behavior contract ${contract.id} has unknown authority kind ${authority.kind}`,
        )
      }
    }
  }
  for (const block of blocks) {
    if (!contractIds.has(block.id)) {
      failures.push(
        `behavior contract ${block.id} on owner page ${block.href} is missing from registry`,
      )
    }
  }
}

function surfaceDiagnostic(surface, symbol, owner, sourcePath, target) {
  return `package ${surface.packageName} subpath ${surface.subpath} symbol ${symbol} owner page ${owner} source barrel ${sourcePath} (manifest target ${target})`
}

const STABLE_GENERATED_ROUTE_EXPORTS = [
  "DawnRouteParams",
  "DawnRoutePath",
  "DawnRouteTools",
  "RouteTools",
]
const CONDITIONAL_GENERATED_ROUTE_EXPORTS = ["DawnRouteState", "RouteState"]

function diagnosticText(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
}

function generatedModuleInventory(declarations, moduleName) {
  const declarationPath = "/fixture/dawn.generated.d.ts"
  const scenarioPath = "/fixture/scenarios.generated.d.ts"
  const libraryPath = "/fixture/generated-lib.d.ts"
  const files = new Map([
    [declarationPath, declarations],
    [scenarioPath, ""],
    [
      libraryPath,
      `interface Array<T> {}
interface Boolean {}
interface CallableFunction {}
interface Function {}
interface IArguments {}
interface NewableFunction {}
interface Number {}
interface Object {}
interface Promise<T> {}
interface RegExp {}
interface String {}
`,
    ],
  ])
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
    noLib: true,
    skipLibCheck: false,
    types: [],
  }
  const defaultHost = ts.createCompilerHost(options)
  const host = {
    ...defaultHost,
    fileExists(path) {
      return files.has(normalizePath(path)) || defaultHost.fileExists(path)
    },
    getCurrentDirectory() {
      return "/fixture"
    },
    getSourceFile(path, languageVersion) {
      const source = files.get(normalizePath(path))
      return source === undefined
        ? defaultHost.getSourceFile(path, languageVersion)
        : ts.createSourceFile(path, source, languageVersion, true)
    },
    readFile(path) {
      return files.get(normalizePath(path)) ?? defaultHost.readFile(path)
    },
  }
  const program = ts.createProgram([...files.keys()], options, host)
  const syntactic = program.getSyntacticDiagnostics()
  if (syntactic.length > 0) {
    return { failure: `syntactic diagnostic: ${diagnosticText(syntactic[0])}` }
  }
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    return { failure: `semantic diagnostic: ${diagnosticText(diagnostics[0])}` }
  }
  const checker = program.getTypeChecker()
  const modules = checker
    .getAmbientModules()
    .filter((candidate) => candidate.name === JSON.stringify(moduleName))
  if (modules.length === 0) return { failure: "ambient module is missing" }
  const declarationsForModule = modules[0].declarations ?? []
  if (modules.length !== 1 || declarationsForModule.length !== 1) {
    return { failure: "ambient module must have exactly one declaration" }
  }
  const exports = checker.getExportsOfModule(modules[0])
  const valueExports = []
  for (const exported of exports) {
    const resolved =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
    if (!(resolved.flags & ts.SymbolFlags.Type) || resolved.flags & ts.SymbolFlags.Value) {
      valueExports.push(exported.name)
    }
  }
  return { exports: exports.map(({ name }) => name).sort(), valueExports }
}

function validateGeneratedSurfaces(fixture, failures) {
  const surfaces = (fixture.artifacts ?? []).filter(({ kind }) => kind === "generated")
  const authorities = fixture.generatedAuthorities ?? []
  const ownership = fixture.documents.flatMap(generatedOwnershipRowsFromDocument)
  if (surfaces.length === 0 && authorities.length === 0 && ownership.length === 0) return
  if (surfaces.length !== 1) {
    failures.push(
      surfaces.length === 0
        ? "generated surface dawn:routes registry record is missing"
        : `generated surface dawn:routes must have exactly one registry record; received ${surfaces.length}`,
    )
  }
  for (const surface of surfaces) {
    const schemaFields = [
      "audience",
      "coverage",
      "kind",
      "moduleName",
      "ownerHref",
      "stability",
      "surfaceKind",
    ]
    if (
      !surface ||
      typeof surface !== "object" ||
      JSON.stringify(Object.keys(surface).sort()) !== JSON.stringify(schemaFields)
    ) {
      failures.push(
        `generated surface ${String(surface?.moduleName ?? "dawn:routes")} fields do not match the generated-types schema (unexpected: ${
          Object.keys(surface ?? {})
            .filter((field) => !schemaFields.includes(field))
            .join(", ") || "none"
        })`,
      )
      continue
    }
    if (
      surface.moduleName !== "dawn:routes" ||
      surface.surfaceKind !== "generated-types" ||
      surface.coverage !== "detailed" ||
      surface.ownerHref !== "/docs/api/generated-routes" ||
      surface.audience !== "application" ||
      surface.stability !== "supported"
    ) {
      failures.push(
        `generated surface dawn:routes owner must be /docs/api/generated-routes, audience must be application, and stability must be supported`,
      )
    }
  }
  const surface = surfaces[0]
  if (!surface) return
  const matchingAuthorities = authorities.filter(
    ({ moduleName }) => moduleName === surface.moduleName,
  )
  if (matchingAuthorities.length === 0) {
    failures.push(`generated surface dawn:routes authority is missing`)
    return
  }
  if (matchingAuthorities.length !== 1) {
    failures.push(`generated surface dawn:routes must have exactly one generated authority`)
    return
  }
  const inventory = generatedModuleInventory(
    matchingAuthorities[0].declarations,
    surface.moduleName,
  )
  if (inventory.failure) {
    failures.push(`generated surface dawn:routes ${inventory.failure}`)
    return
  }
  if (inventory.valueExports.length > 0) {
    failures.push(
      `generated surface dawn:routes has value export ${inventory.valueExports.join(", ")}; generated exports must be type-only`,
    )
  }
  const sourceExports = inventory.exports
  const hasAnyStateExport = CONDITIONAL_GENERATED_ROUTE_EXPORTS.some((symbol) =>
    sourceExports.includes(symbol),
  )
  const expectedExports = [
    ...STABLE_GENERATED_ROUTE_EXPORTS,
    ...(hasAnyStateExport ? CONDITIONAL_GENERATED_ROUTE_EXPORTS : []),
  ].sort()
  if (JSON.stringify(sourceExports) !== JSON.stringify(expectedExports)) {
    failures.push(
      `generated surface dawn:routes exports ${JSON.stringify(sourceExports)} instead of exact ${JSON.stringify(expectedExports)}`,
    )
  }

  const ownedRows = ownership.filter((row) => row.moduleName === surface.moduleName)
  const ownerPaths = new Set(ownedRows.map(({ href, path }) => `${href}\0${path}`))
  if (ownerPaths.size === 0) {
    failures.push(
      `generated surface dawn:routes owner page ${surface.ownerHref} is missing a Generated export table`,
    )
    return
  }
  if (ownerPaths.size !== 1 || ownedRows.some(({ href }) => href !== surface.ownerHref)) {
    failures.push(
      `generated surface dawn:routes Generated export table must exist once on canonical owner page ${surface.ownerHref}`,
    )
  }
  const ownedExports = ownedRows.map(({ symbol }) => symbol).sort()
  if (
    new Set(ownedExports).size !== ownedExports.length ||
    JSON.stringify(ownedExports) !== JSON.stringify(sourceExports)
  ) {
    failures.push(
      `generated surface dawn:routes owner page ${surface.ownerHref} exports ${JSON.stringify(ownedExports)} instead of source ${JSON.stringify(sourceExports)}`,
    )
  }

  for (const row of ownership) {
    if (row.moduleName !== surface.moduleName) {
      failures.push(
        `Generated export ${row.symbol} on owner page ${row.path} names unknown generated surface ${row.moduleName}`,
      )
    }
  }
}

export function analyzeApiInventoryFixture(fixture) {
  const failures = []
  const program = virtualProgram(fixture.files ?? {}, fixture.packages ?? [])
  const ownership = fixture.documents.flatMap(ownershipRowsFromDocument)
  const contracts = fixture.documents.flatMap(contractFencesFromDocument)
  const fieldTables = fixture.documents.flatMap(fieldTablesFromDocument)
  const ownershipByKey = new Map()
  for (const row of ownership) {
    const key = `${row.packageName}#${row.subpath}:${row.symbol}`
    const existing = ownershipByKey.get(key) ?? []
    existing.push(row)
    ownershipByKey.set(key, existing)
  }

  const contractsByKey = new Map()
  for (const contract of contracts) {
    if (!contract.key) continue
    const existing = contractsByKey.get(contract.key) ?? []
    existing.push(contract)
    contractsByKey.set(contract.key, existing)
  }
  const fieldTablesByKey = new Map()
  for (const table of fieldTables) {
    if (!table.key || table.invalidStructure) continue
    const existing = fieldTablesByKey.get(table.key) ?? []
    existing.push(table)
    fieldTablesByKey.set(table.key, existing)
  }

  const detailedSurfaces = new Map()
  const manifestsByName = new Map(
    (fixture.packages ?? []).map(({ dir, packageJson }) => [
      packageJson.name,
      { dir, packageJson },
    ]),
  )
  for (const surface of fixture.artifacts ?? []) {
    if (
      surface.kind !== "import" ||
      surface.coverage !== "detailed" ||
      surface.surfaceKind !== "typescript-runtime"
    ) {
      continue
    }
    const packageEntry = manifestsByName.get(surface.packageName)
    const owner = surface.ownerHref ?? "unknown"
    if (!packageEntry) {
      failures.push(
        `package ${surface.packageName} subpath ${surface.subpath} symbol * owner page ${owner} source barrel missing: public package manifest is absent`,
      )
      continue
    }
    const exportValue = exportValueAtSubpath(packageEntry.packageJson.exports, surface.subpath)
    if (exportValue === undefined) {
      failures.push(
        `package ${surface.packageName} subpath ${surface.subpath} symbol * owner page ${owner} source barrel missing because manifest subpath is absent`,
      )
      continue
    }
    const target = relevantExportTarget(exportValue)
    const sourcePath = authoredTargetCandidates(packageEntry.dir, target).find((candidate) =>
      Object.hasOwn(fixture.files, candidate),
    )
    if (!sourcePath) {
      failures.push(
        `package ${surface.packageName} subpath ${surface.subpath} symbol * owner page ${owner} wrong source target ${String(target)} has no authored source barrel`,
      )
      continue
    }
    const inventory = moduleInventory(program, sourcePath)
    detailedSurfaces.set(`${surface.packageName}#${surface.subpath}`, {
      inventory,
      owner,
      sourcePath,
      surface,
      target,
    })
    const sourceSymbols = new Set(inventory.exports.keys())
    const surfacePrefix = `${surface.packageName}#${surface.subpath}:`
    const surfaceOwners = [...ownershipByKey.entries()].filter(([key]) =>
      key.startsWith(surfacePrefix),
    )
    for (const [key, rows] of surfaceOwners) {
      const symbol = key.slice(surfacePrefix.length)
      if (rows.length > 1) {
        failures.push(
          `${surfaceDiagnostic(surface, symbol, rows.map(({ path }) => path).join(", "), sourcePath, target)} has duplicate owners`,
        )
      }
      if (!sourceSymbols.has(symbol)) {
        failures.push(
          `${surfaceDiagnostic(surface, symbol, rows[0]?.path ?? owner, sourcePath, target)} is stale or missing from source`,
        )
        continue
      }
      const ownedContracts = contractsByKey.get(key) ?? []
      if (ownedContracts.length > 1) {
        failures.push(
          `${surfaceDiagnostic(surface, symbol, rows[0]?.path ?? owner, sourcePath, target)} has duplicate API contracts`,
        )
        continue
      }
      if (ownedContracts.length === 1) {
        const authoredFingerprint = contractFingerprint(ownedContracts[0].source, symbol)
        const sourceFingerprint = inventory.exports.get(symbol)?.fingerprint
        const declarations = inventory.exports.get(symbol)?.declarations ?? []
        const unsupportedKind = declarations.find(
          (declaration) => ts.isEnumDeclaration(declaration) || ts.isModuleDeclaration(declaration),
        )
        if (unsupportedKind) {
          failures.push(
            `${surfaceDiagnostic(surface, symbol, rows[0]?.path ?? owner, sourcePath, target)} api-contract ${ts.isEnumDeclaration(unsupportedKind) ? "enum" : "namespace"} declarations are unsupported`,
          )
        } else if (sourceFingerprint === null) {
          failures.push(
            `${surfaceDiagnostic(surface, symbol, rows[0]?.path ?? owner, sourcePath, target)} contract source declaration merge is unsupported or unresolved`,
          )
        } else if (
          authoredFingerprint === null ||
          JSON.stringify(authoredFingerprint) !== JSON.stringify(sourceFingerprint)
        ) {
          failures.push(
            `${surfaceDiagnostic(surface, symbol, rows[0]?.path ?? owner, sourcePath, target)} contract fingerprint does not match source: authored ${JSON.stringify(authoredFingerprint)}, source ${JSON.stringify(sourceFingerprint)}`,
          )
        }
      }
    }
    for (const symbol of sourceSymbols) {
      const key = `${surfacePrefix}${symbol}`
      if (!ownershipByKey.has(key)) {
        failures.push(
          `${surfaceDiagnostic(surface, symbol, owner, sourcePath, target)} is an undocumented detailed export with no owner`,
        )
      }
    }
    for (const [key, keyedContracts] of contractsByKey) {
      if (!key.startsWith(surfacePrefix) || ownershipByKey.has(key)) continue
      const symbol = key.slice(surfacePrefix.length)
      failures.push(
        `${surfaceDiagnostic(surface, symbol, keyedContracts[0]?.path ?? owner, sourcePath, target)} has a contract/table owner key mismatch`,
      )
    }

    for (const table of fieldTables) {
      if (!table.key || table.invalidStructure) continue
      const parsed = parseContractKey(table.key)
      if (
        !parsed ||
        parsed.packageName !== surface.packageName ||
        parsed.subpath !== surface.subpath
      ) {
        continue
      }
      const sourceFields = exportedProperties(inventory.exports.get(parsed.symbol), program.checker)
      const authoredFields = table.fields.map((field) => ({
        name: field.name,
        readonly: field.readonly,
        type: normalizePrinted(field.type),
        required: field.required,
        validName: field.validName,
      }))
      const comparableSource = sourceFields?.map(({ name, readonly, type, required }) => ({
        name,
        readonly,
        type: type ? normalizePrinted(type) : null,
        required,
        validName: true,
      }))
      if (!sourceFields || JSON.stringify(authoredFields) !== JSON.stringify(comparableSource)) {
        failures.push(
          `package ${surface.packageName} subpath ${surface.subpath} symbol ${parsed.symbol} field table on owner page ${table.path} does not match source fields (including name, type, readonly contract, and required status) in source barrel ${sourcePath} (manifest target ${target})`,
        )
      }
    }
  }

  for (const contract of contracts) {
    if (contract.invalidTag) {
      failures.push(
        `malformed api-contract fence metadata ${JSON.stringify(contract.invalidTag)} on owner page ${contract.path}`,
      )
      continue
    }
    const parsed = parseContractKey(contract.key)
    if (!parsed) {
      failures.push(
        `malformed api-contract key ${JSON.stringify(contract.key)} on owner page ${contract.path}`,
      )
      continue
    }
    const context = detailedSurfaces.get(`${parsed.packageName}#${parsed.subpath}`)
    if (!context?.inventory.exports.has(parsed.symbol)) {
      failures.push(
        `foreign api-contract ${contract.key} on owner page ${contract.path} does not map to a known detailed package, subpath, and symbol`,
      )
      continue
    }
    const owners = ownershipByKey.get(contract.key) ?? []
    if (owners.length === 0) {
      failures.push(
        `${surfaceDiagnostic(context.surface, parsed.symbol, contract.path, context.sourcePath, context.target)} api-contract has no ownership row`,
      )
    } else if (
      !owners.some((owner) => owner.href === contract.href && owner.path === contract.path)
    ) {
      failures.push(
        `${surfaceDiagnostic(context.surface, parsed.symbol, contract.path, context.sourcePath, context.target)} contract must be on the same href/path as its owner page`,
      )
    }
  }

  for (const table of fieldTables) {
    if (table.invalidCaption || table.missingCaption || table.invalidStructure) {
      if (table.invalidStructure) {
        const parsed = parseContractKey(table.key)
        const context = parsed
          ? detailedSurfaces.get(`${parsed.packageName}#${parsed.subpath}`)
          : null
        failures.push(
          context && parsed
            ? `${surfaceDiagnostic(context.surface, parsed.symbol, table.path, context.sourcePath, context.target)} Fields field table has invalid ${table.invalidStructure} structure`
            : `Fields ${String(table.key)} field table on owner page ${table.path} has invalid ${table.invalidStructure} structure`,
        )
      } else {
        failures.push(
          `recognizable field table on owner page ${table.path} requires an immediate exact Fields caption`,
        )
      }
      continue
    }
    const parsed = parseContractKey(table.key)
    if (!parsed) {
      failures.push(`malformed Fields key ${JSON.stringify(table.key)} on owner page ${table.path}`)
      continue
    }
    const context = detailedSurfaces.get(`${parsed.packageName}#${parsed.subpath}`)
    if (!context?.inventory.exports.has(parsed.symbol)) {
      failures.push(
        `foreign Fields caption ${table.key} on owner page ${table.path} does not map to a known detailed package, subpath, and symbol`,
      )
      continue
    }
    const owners = ownershipByKey.get(table.key) ?? []
    const keyedTables = fieldTablesByKey.get(table.key) ?? []
    if (keyedTables.length > 1 && keyedTables[0] === table) {
      failures.push(
        `${surfaceDiagnostic(context.surface, parsed.symbol, keyedTables.map(({ path }) => path).join(", "), context.sourcePath, context.target)} has duplicate Fields tables`,
      )
    }
    if (owners.length === 0) {
      failures.push(
        `${surfaceDiagnostic(context.surface, parsed.symbol, table.path, context.sourcePath, context.target)} Fields caption has no ownership row`,
      )
    } else if (!owners.some((owner) => owner.href === table.href && owner.path === table.path)) {
      failures.push(
        `${surfaceDiagnostic(context.surface, parsed.symbol, table.path, context.sourcePath, context.target)} Fields caption must be on the same href/path as its owner page`,
      )
    }
  }

  for (const row of ownership) {
    if (!row.packageName || !row.subpath) {
      failures.push(
        `malformed ownership heading ${JSON.stringify(row.heading)} for symbol ${row.symbol} on owner page ${row.path}`,
      )
      continue
    }
    const key = `${row.packageName}#${row.subpath}:${row.symbol}`
    const context = detailedSurfaces.get(`${row.packageName}#${row.subpath}`)
    if (!context?.inventory.exports.has(row.symbol)) {
      failures.push(
        `${key} ownership row on owner page ${row.path} does not map to a known detailed package, subpath, and symbol`,
      )
      continue
    }
    if (context.owner !== "unknown" && row.href !== context.owner) {
      failures.push(
        `${surfaceDiagnostic(context.surface, row.symbol, row.path, context.sourcePath, context.target)} ownership row must be on canonical owner page ${context.owner}`,
      )
    }
  }

  validateBehaviorContracts(fixture, program, failures)
  validateGeneratedSurfaces(fixture, failures)
  return {
    name: fixture.name,
    failures,
    headings: fixture.documents
      .flatMap(({ source }) => headingsFromDocument(source))
      .map(({ level, text }) => ({ level, text })),
  }
}

export function analyzeApiInventoryBatch(fixtures) {
  if (!Array.isArray(fixtures)) throw new Error("API inventory batch input must be an array")
  return fixtures.map(analyzeApiInventoryFixture)
}

async function readTree(directory, root, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await readTree(path, root, output)
    } else if (/\.[cm]?tsx?$/.test(entry.name)) {
      output[normalizePath(relative(root, path))] = await readFile(path, "utf8")
    }
  }
}

/**
 * Reads only authored TypeScript belonging to public packages. Consumers provide the
 * detailed artifact/page registries; this helper deliberately does not enable a global check.
 */
export async function readPublicSourceInventory(rootDir) {
  const publicPackages = await readPublicPackages(rootDir)
  const files = {}
  for (const { dir } of publicPackages) {
    const sourceDirectory = resolve(dir, "src")
    try {
      await readTree(sourceDirectory, rootDir, files)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
  return {
    packages: publicPackages.map(({ dir, packageJson }) => ({
      dir: normalizePath(relative(rootDir, dir)),
      packageJson,
    })),
    files,
  }
}

export const __test = {
  authoredTargetCandidates,
  relevantExportTarget,
}
