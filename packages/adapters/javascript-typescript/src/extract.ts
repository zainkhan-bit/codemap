/**
 * JavaScript / TypeScript / JSX / TSX fact extraction from a Tree-sitter tree.
 * Pure syntax: no module resolution, no type checking.
 */
import {
  DiagnosticCodes,
  type AdapterDiagnostic,
  type CallFact,
  type ExportFact,
  type ImportFact,
  type ImportedName,
  type InheritanceFact,
  type SymbolFact,
  type SymbolKind,
} from "@codemap/contracts";
import { computedCalleeSummary, identifierChain, summarize, type SourceText, type SyntaxNode } from "@codemap/parser-runtime";

export interface JsExtractionResult {
  imports: ImportFact[];
  exports: ExportFact[];
  symbols: SymbolFact[];
  calls: CallFact[];
  inheritance: InheritanceFact[];
  diagnostics: AdapterDiagnostic[];
}

interface Scope {
  /** Symbol that owns calls made here (function/method/class). */
  callerLocalId?: string;
  /** Symbol under which new declarations nest. */
  parentLocalId?: string;
  parentQualified?: string;
  /** True inside a function body (local variables are not recorded). */
  inFunction: boolean;
  /** Set when walking the declaration of an `export` statement. */
  exportedDecl: boolean;
}

const IDENT = new Set(["identifier", "this", "super", "property_identifier", "type_identifier", "shorthand_property_identifier"]);
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const CLASS_VALUES = new Set(["class"]);

function kids(n: SyntaxNode): SyntaxNode[] {
  return n.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

function allKids(n: SyntaxNode): SyntaxNode[] {
  return n.children.filter((c): c is SyntaxNode => c !== null);
}

function stringValue(n: SyntaxNode | null): string | undefined {
  if (!n || n.type !== "string") return undefined;
  const frag = kids(n).filter((c) => c.type === "string_fragment" || c.type === "escape_sequence");
  if (kids(n).some((c) => c.type !== "string_fragment" && c.type !== "escape_sequence")) return undefined;
  return frag.map((f) => f.text).join("");
}

function hasToken(n: SyntaxNode, token: string): boolean {
  return allKids(n).some((c) => !c.isNamed && c.type === token);
}

function paramCount(n: SyntaxNode): number | undefined {
  const params = n.childForFieldName("parameters") ?? n.childForFieldName("parameter");
  if (!params) return undefined;
  if (params.type === "identifier") return 1;
  return kids(params).filter((c) => c.type !== "comment").length;
}

export class JsExtractor {
  private readonly out: JsExtractionResult = { imports: [], exports: [], symbols: [], calls: [], inheritance: [], diagnostics: [] };
  private nextId = 0;
  private depthWarned = false;

  constructor(
    private readonly src: SourceText,
    private readonly maxDepth: number,
    private readonly opts: { calls: boolean; inheritance: boolean },
  ) {}

  run(root: SyntaxNode): JsExtractionResult {
    this.visitChildren(root, { inFunction: false, exportedDecl: false }, 0);
    this.finalizeExports();
    return this.out;
  }

  private span(n: SyntaxNode) {
    return this.src.span(n.startIndex, n.endIndex);
  }

  private visitChildren(n: SyntaxNode, scope: Scope, depth: number): void {
    for (const c of kids(n)) this.visit(c, scope, depth + 1);
  }

  private visit(n: SyntaxNode, scope: Scope, depth: number): void {
    if (depth > this.maxDepth) {
      if (!this.depthWarned) {
        this.depthWarned = true;
        this.out.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "warning", message: `syntax nesting deeper than ${this.maxDepth}; deeper constructs were not extracted`, span: this.span(n) });
      }
      return;
    }
    switch (n.type) {
      case "import_statement":
        return this.importStatement(n);
      case "export_statement":
        return this.exportStatement(n, scope, depth);
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature":
        return this.functionLike(n, scope, depth, "function");
      case "class_declaration":
      case "abstract_class_declaration":
        return void this.classLike(n, scope, depth);
      case "method_definition":
      case "method_signature":
      case "abstract_method_signature":
        return this.method(n, scope, depth);
      case "field_definition":
      case "public_field_definition":
        return this.field(n, scope, depth);
      case "interface_declaration":
        return this.interfaceLike(n, scope, depth);
      case "type_alias_declaration":
        return void this.addSymbol(n, n.childForFieldName("name"), "type", scope, {});
      case "enum_declaration":
        return void this.addSymbol(n, n.childForFieldName("name"), "enum", scope, {});
      case "internal_module":
      case "module": {
        const name = n.childForFieldName("name");
        if (name?.type === "string") return; // `declare module "x"` augmentations are not declarations of this file
        const id = this.addSymbol(n, name, "namespace", scope, {});
        const body = n.childForFieldName("body");
        if (body && id) this.visitChildren(body, { ...scope, parentLocalId: id.localId, parentQualified: id.qualifiedName, exportedDecl: false }, depth);
        return;
      }
      case "lexical_declaration":
      case "variable_declaration":
        for (const d of kids(n)) if (d.type === "variable_declarator") this.declarator(d, n, scope, depth);
        return;
      case "call_expression":
        this.call(n, scope);
        return this.visitChildren(n, scope, depth);
      case "new_expression":
        this.newExpr(n, scope);
        return this.visitChildren(n, scope, depth);
      case "assignment_expression":
        this.commonJsExport(n, scope);
        return this.visitChildren(n, scope, depth);
      case "arrow_function":
      case "function_expression":
      case "function":
      case "generator_function":
        return this.visitChildren(n, { ...scope, inFunction: true, exportedDecl: false }, depth);
      default:
        return this.visitChildren(n, { ...scope, exportedDecl: false }, depth);
    }
  }

  // ------------------------------------------------------------------ symbols

  private addSymbol(
    decl: SyntaxNode,
    nameNode: SyntaxNode | null,
    kind: SymbolKind,
    scope: Scope,
    extra: { modifiers?: string[]; fingerprint?: string; languageKind?: string; name?: string },
  ): SymbolFact | undefined {
    const name = extra.name ?? (nameNode ? nameNode.text : undefined);
    if (!name) {
      this.out.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "info", message: `${decl.type} with a computed or missing name was not recorded`, span: this.span(decl) });
      return undefined;
    }
    const fact: SymbolFact = {
      localId: `s${this.nextId++}`,
      name,
      qualifiedName: scope.parentQualified ? `${scope.parentQualified}.${name}` : name,
      symbolKind: kind,
      languageKind: extra.languageKind ?? decl.type,
      ...(extra.fingerprint !== undefined ? { signatureFingerprint: extra.fingerprint } : {}),
      span: this.span(decl),
      ...(nameNode ? { nameSpan: this.span(nameNode) } : {}),
      ...(scope.parentLocalId ? { parentLocalId: scope.parentLocalId } : {}),
      exported: scope.exportedDecl ? true : scope.parentLocalId ? "unknown" : false,
      modifiers: extra.modifiers ?? [],
    };
    this.out.symbols.push(fact);
    return fact;
  }

  private modifiers(n: SyntaxNode): string[] {
    const mods = new Set<string>();
    for (const c of allKids(n)) {
      if (["static", "async", "get", "set", "abstract", "readonly", "override", "declare", "*"].includes(c.type)) mods.add(c.type === "*" ? "generator" : c.type);
      if (c.type === "accessibility_modifier") mods.add(c.text);
      if (c.type === "override_modifier") mods.add("override");
    }
    if (n.childForFieldName("name")?.type === "private_property_identifier") mods.add("private");
    return [...mods].sort();
  }

  private functionLike(n: SyntaxNode, scope: Scope, depth: number, kind: SymbolKind): void {
    const pc = paramCount(n);
    const sym = this.addSymbol(n, n.childForFieldName("name"), kind, scope, { modifiers: this.modifiers(n), ...(pc !== undefined ? { fingerprint: `params:${pc}` } : {}) });
    const body = n.childForFieldName("body");
    const inner: Scope = sym ? { callerLocalId: sym.localId, parentLocalId: sym.localId, parentQualified: sym.qualifiedName, inFunction: true, exportedDecl: false } : { ...scope, inFunction: true, exportedDecl: false };
    for (const c of kids(n)) if (c.id !== body?.id) this.visit(c, { ...inner, parentLocalId: scope.parentLocalId, parentQualified: scope.parentQualified }, depth + 1);
    if (body) this.visitChildren(body, inner, depth);
  }

  private classLike(n: SyntaxNode, scope: Scope, depth: number, nameOverride?: { node: SyntaxNode | null; name?: string }): SymbolFact | undefined {
    const nameNode = nameOverride ? nameOverride.node : n.childForFieldName("name");
    const sym = this.addSymbol(n, nameNode, "class", scope, { modifiers: n.type === "abstract_class_declaration" ? ["abstract"] : this.modifiers(n), ...(nameOverride?.name ? { name: nameOverride.name } : {}) });
    const heritage = kids(n).find((c) => c.type === "class_heritage");
    if (sym && heritage && this.opts.inheritance) this.heritage(heritage, sym);
    const body = n.childForFieldName("body");
    if (heritage) this.visitChildren(heritage, { ...scope, exportedDecl: false }, depth);
    if (body) this.visitChildren(body, sym ? { callerLocalId: sym.localId, parentLocalId: sym.localId, parentQualified: sym.qualifiedName, inFunction: false, exportedDecl: false } : scope, depth);
    return sym;
  }

  private heritage(h: SyntaxNode, sym: SymbolFact): void {
    const clauses = kids(h);
    const typeTargets = (clause: SyntaxNode, kind: "extends" | "implements") => {
      for (const t of kids(clause)) {
        const target = t.type === "generic_type" ? t.childForFieldName("name") : t;
        const chain = target ? identifierChain(target.type === "nested_type_identifier" ? null : target, "member_expression", "object", "property", IDENT) ?? nestedTypeChain(target) : undefined;
        if (chain) this.out.inheritance.push({ symbolLocalId: sym.localId, kind, targetName: chain.join("."), summary: summarize(t.text), span: this.span(t) });
        else if (t.type !== "type_arguments") this.out.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "info", message: `${kind} target is an expression; not recorded as inheritance`, span: this.span(t) });
      }
    };
    if (clauses.some((c) => c.type === "extends_clause" || c.type === "implements_clause")) {
      for (const c of clauses) {
        if (c.type === "extends_clause") {
          const values = c.childrenForFieldName("value").filter((v): v is SyntaxNode => v !== null);
          for (const v of values.length ? values : kids(c).filter((k) => k.type !== "type_arguments")) {
            const chain = identifierChain(v, "member_expression", "object", "property", IDENT);
            if (chain) this.out.inheritance.push({ symbolLocalId: sym.localId, kind: "extends", targetName: chain.join("."), summary: summarize(v.text), span: this.span(v) });
            else this.out.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "info", message: "extends target is an expression; not recorded as inheritance", span: this.span(v) });
          }
        } else if (c.type === "implements_clause") typeTargets(c, "implements");
      }
      return;
    }
    // JavaScript grammar: class_heritage directly holds the `extends` expression.
    const expr = clauses[0];
    if (!expr) return;
    const chain = identifierChain(expr, "member_expression", "object", "property", IDENT);
    if (chain) this.out.inheritance.push({ symbolLocalId: sym.localId, kind: "extends", targetName: chain.join("."), summary: summarize(expr.text), span: this.span(expr) });
    else this.out.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "info", message: "extends target is an expression; not recorded as inheritance", span: this.span(expr) });
  }

  private interfaceLike(n: SyntaxNode, scope: Scope, depth: number): void {
    const sym = this.addSymbol(n, n.childForFieldName("name"), "interface", scope, {});
    if (!sym) return;
    const ext = kids(n).find((c) => c.type === "extends_type_clause");
    if (ext && this.opts.inheritance) {
      for (const t of kids(ext)) {
        const target = t.type === "generic_type" ? t.childForFieldName("name") : t;
        const chain = target ? (IDENT.has(target.type) ? [target.text] : nestedTypeChain(target)) : undefined;
        if (chain) this.out.inheritance.push({ symbolLocalId: sym.localId, kind: "extends", targetName: chain.join("."), summary: summarize(t.text), span: this.span(t) });
      }
    }
    const body = n.childForFieldName("body");
    if (body) this.visitChildren(body, { callerLocalId: sym.localId, parentLocalId: sym.localId, parentQualified: sym.qualifiedName, inFunction: false, exportedDecl: false }, depth);
  }

  private method(n: SyntaxNode, scope: Scope, depth: number): void {
    const nameNode = n.childForFieldName("name");
    if (nameNode?.type === "computed_property_name") {
      this.out.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "info", message: "method with computed name was not recorded", span: this.span(n) });
      this.visitChildren(n, { ...scope, inFunction: true }, depth);
      return;
    }
    const isCtor = nameNode?.text === "constructor";
    this.functionLike(n, scope, depth, isCtor ? "constructor" : "method");
  }

  private field(n: SyntaxNode, scope: Scope, depth: number): void {
    const nameNode = n.childForFieldName("name") ?? n.childForFieldName("property");
    const value = n.childForFieldName("value");
    if (nameNode && nameNode.type !== "computed_property_name") {
      const isFn = value && FUNCTION_VALUES.has(value.type);
      const pc = isFn ? paramCount(value) : undefined;
      const sym = this.addSymbol(n, nameNode, isFn ? "method" : "field", scope, { modifiers: this.modifiers(n), ...(pc !== undefined ? { fingerprint: `params:${pc}` } : {}) });
      if (value) this.visit(value, sym && isFn ? { callerLocalId: sym.localId, parentLocalId: sym.localId, parentQualified: sym.qualifiedName, inFunction: true, exportedDecl: false } : { ...scope, exportedDecl: false }, depth + 1);
      return;
    }
    this.visitChildren(n, scope, depth);
  }

  private declarator(d: SyntaxNode, decl: SyntaxNode, scope: Scope, depth: number): void {
    const nameNode = d.childForFieldName("name");
    const value = d.childForFieldName("value");
    if (value && this.requireImport(value, nameNode)) return;
    if (nameNode?.type === "identifier" && value && FUNCTION_VALUES.has(value.type)) {
      const pc = paramCount(value);
      const sym = this.addSymbol(d, nameNode, "function", scope, { languageKind: value.type, modifiers: this.modifiers(value), ...(pc !== undefined ? { fingerprint: `params:${pc}` } : {}) });
      this.visitChildren(value, sym ? { callerLocalId: sym.localId, parentLocalId: sym.localId, parentQualified: sym.qualifiedName, inFunction: true, exportedDecl: false } : { ...scope, inFunction: true }, depth);
      return;
    }
    if (nameNode?.type === "identifier" && value && CLASS_VALUES.has(value.type)) {
      this.classLike(value, scope, depth, { node: nameNode });
      return;
    }
    if (nameNode?.type === "identifier" && !scope.inFunction) {
      const mods = hasToken(decl, "const") ? ["const"] : [];
      this.addSymbol(d, nameNode, "variable", scope, { modifiers: mods, languageKind: decl.type });
    }
    if (value) this.visit(value, { ...scope, exportedDecl: false }, depth + 1);
  }

  // ------------------------------------------------------------------ imports / exports

  private importedNamesFromClause(clause: SyntaxNode): { names: ImportedName[]; ns?: string } {
    const names: ImportedName[] = [];
    let ns: string | undefined;
    for (const c of kids(clause)) {
      if (c.type === "identifier") names.push({ name: "default", alias: c.text });
      else if (c.type === "namespace_import") ns = kids(c).find((k) => k.type === "identifier")?.text;
      else if (c.type === "named_imports") {
        for (const s of kids(c)) {
          if (s.type !== "import_specifier") continue;
          const name = s.childForFieldName("name");
          const alias = s.childForFieldName("alias");
          if (name) names.push(alias ? { name: name.text, alias: alias.text } : { name: name.text });
        }
      }
    }
    return { names, ...(ns ? { ns } : {}) };
  }

  private importStatement(n: SyntaxNode): void {
    const source = n.childForFieldName("source");
    const typeOnly = hasToken(n, "type");
    const req = kids(n).find((c) => c.type === "import_require_clause");
    if (req) {
      const alias = kids(req).find((c) => c.type === "identifier")?.text;
      const spec = stringValue(req.childForFieldName("source") ?? kids(req).find((c) => c.type === "string") ?? null);
      this.out.imports.push({ ...(spec !== undefined ? { specifier: spec } : {}), form: "commonjs_require", importedNames: [], ...(alias ? { namespaceAlias: alias } : {}), isTypeOnly: false, isDynamicExpression: spec === undefined, summary: summarize(n.text), span: this.span(n) });
      return;
    }
    const spec = stringValue(source);
    const clause = kids(n).find((c) => c.type === "import_clause");
    const { names, ns } = clause ? this.importedNamesFromClause(clause) : { names: [] as ImportedName[], ns: undefined };
    const attrs = kids(n).find((c) => c.type === "import_attribute");
    this.out.imports.push({
      ...(spec !== undefined ? { specifier: spec } : {}),
      form: "static_import",
      importedNames: names,
      ...(ns ? { namespaceAlias: ns } : {}),
      isTypeOnly: typeOnly,
      isDynamicExpression: false,
      ...(attrs ? { importAttributes: { raw: summarize(attrs.text, 80) } } : {}),
      summary: summarize(n.text),
      span: this.span(n),
    });
  }

  private exportStatement(n: SyntaxNode, scope: Scope, depth: number): void {
    const source = n.childForFieldName("source");
    const typeOnly = hasToken(n, "type");
    const isDefault = hasToken(n, "default");
    const decl = n.childForFieldName("declaration");
    const value = n.childForFieldName("value");
    const summary = summarize(n.text);
    const span = this.span(n);

    if (source) {
      const spec = stringValue(source);
      const clause = kids(n).find((c) => c.type === "export_clause");
      const nsExport = kids(n).find((c) => c.type === "namespace_export");
      const importIndex = this.out.imports.length;
      const names: ImportedName[] = [];
      if (clause) {
        for (const s of kids(clause)) {
          if (s.type !== "export_specifier") continue;
          const name = s.childForFieldName("name");
          const alias = s.childForFieldName("alias");
          if (!name) continue;
          names.push(alias ? { name: name.text, alias: alias.text } : { name: name.text });
          this.out.exports.push({ kind: "re_export", name: alias?.text ?? name.text, localName: name.text, ...(spec !== undefined ? { specifier: spec } : {}), importIndex, isTypeOnly: typeOnly, summary, span });
        }
      } else if (nsExport) {
        const alias = kids(nsExport).find((k) => k.type === "identifier" || k.type === "string")?.text ?? "*";
        names.push({ name: "*", alias });
        this.out.exports.push({ kind: "re_export", name: alias, localName: "*", ...(spec !== undefined ? { specifier: spec } : {}), importIndex, isTypeOnly: typeOnly, summary, span });
      } else {
        names.push({ name: "*" });
        this.out.exports.push({ kind: "re_export_all", name: "*", ...(spec !== undefined ? { specifier: spec } : {}), importIndex, isTypeOnly: typeOnly, summary, span });
      }
      this.out.imports.push({ ...(spec !== undefined ? { specifier: spec } : {}), form: "re_export", importedNames: names, isTypeOnly: typeOnly, isDynamicExpression: false, summary, span });
      return;
    }

    if (decl) {
      const before = this.out.symbols.length;
      this.visit(decl, { ...scope, exportedDecl: true }, depth + 1);
      for (const s of this.out.symbols.slice(before)) {
        if (s.parentLocalId !== scope.parentLocalId) continue;
        this.out.exports.push({ kind: isDefault ? "default" : "declaration", name: isDefault ? "default" : s.name, localName: s.name, isTypeOnly: ["interface", "type"].includes(s.symbolKind), summary, span });
      }
      return;
    }

    const clause = kids(n).find((c) => c.type === "export_clause");
    if (clause) {
      for (const s of kids(clause)) {
        if (s.type !== "export_specifier") continue;
        const name = s.childForFieldName("name");
        const alias = s.childForFieldName("alias");
        if (name) this.out.exports.push({ kind: "named", name: alias?.text ?? name.text, localName: name.text, isTypeOnly: typeOnly, summary, span });
      }
      return;
    }

    if (isDefault && value) {
      if (value.type === "identifier") {
        this.out.exports.push({ kind: "default", name: "default", localName: value.text, isTypeOnly: false, summary, span });
        return;
      }
      if (FUNCTION_VALUES.has(value.type) || value.type === "class") {
        // Anonymous default export: recorded as a symbol named "default".
        const before = this.out.symbols.length;
        if (value.type === "class") this.classLike(value, { ...scope, exportedDecl: true }, depth, { node: value.childForFieldName("name"), name: value.childForFieldName("name")?.text ?? "default" });
        else {
          const pc = paramCount(value);
          const sym = this.addSymbol(value, value.childForFieldName("name"), "function", { ...scope, exportedDecl: true }, { name: value.childForFieldName("name")?.text ?? "default", ...(pc !== undefined ? { fingerprint: `params:${pc}` } : {}) });
          this.visitChildren(value, sym ? { callerLocalId: sym.localId, parentLocalId: sym.localId, parentQualified: sym.qualifiedName, inFunction: true, exportedDecl: false } : scope, depth);
        }
        const sym = this.out.symbols[before];
        if (sym) this.out.exports.push({ kind: "default", name: "default", localName: sym.name, isTypeOnly: false, summary, span });
        return;
      }
      this.out.exports.push({ kind: "default", name: "default", isTypeOnly: false, summary, span });
      this.visit(value, scope, depth + 1);
    }
  }

  /** `module.exports = x`, `module.exports.y = z`, `exports.y = z`. */
  private commonJsExport(n: SyntaxNode, scope: Scope): void {
    if (scope.inFunction) return;
    const left = n.childForFieldName("left");
    const right = n.childForFieldName("right");
    const chain = identifierChain(left, "member_expression", "object", "property", IDENT);
    if (!chain || !right) return;
    const local = right.type === "identifier" ? right.text : undefined;
    const summary = summarize(n.text);
    if (chain.length === 2 && chain[0] === "module" && chain[1] === "exports") {
      this.out.exports.push({ kind: "default", name: "default", ...(local ? { localName: local } : {}), isTypeOnly: false, summary, span: this.span(n) });
    } else if ((chain.length === 3 && chain[0] === "module" && chain[1] === "exports") || (chain.length === 2 && chain[0] === "exports")) {
      const name = chain[chain.length - 1]!;
      this.out.exports.push({ kind: "named", name, ...(local ? { localName: local } : {}), isTypeOnly: false, summary, span: this.span(n) });
    }
  }

  private finalizeExports(): void {
    const exportedLocals = new Set(this.out.exports.filter((e) => e.kind !== "re_export" && e.kind !== "re_export_all").map((e) => e.localName ?? e.name));
    for (const s of this.out.symbols) if (!s.parentLocalId && s.exported === false && exportedLocals.has(s.name)) s.exported = true;
  }

  // ------------------------------------------------------------------ calls

  /** Literal require("x") / import("x"); returns true when the call was consumed as an import. */
  private requireImport(value: SyntaxNode, bindingName: SyntaxNode | null): boolean {
    let call = value;
    if (call.type === "await_expression") call = kids(call)[0] ?? call;
    if (call.type !== "call_expression") return false;
    const fn = call.childForFieldName("function");
    if (!fn || !(fn.type === "identifier" && fn.text === "require")) return false;
    const args = kids(call.childForFieldName("arguments") ?? call).filter((a) => a.type !== "comment");
    const spec = args.length === 1 ? stringValue(args[0]!) : undefined;
    const names: ImportedName[] = [];
    let ns: string | undefined;
    if (bindingName?.type === "identifier") ns = bindingName.text;
    else if (bindingName?.type === "object_pattern") {
      for (const p of kids(bindingName)) {
        if (p.type === "shorthand_property_identifier_pattern") names.push({ name: p.text });
        else if (p.type === "pair_pattern") {
          const k = p.childForFieldName("key");
          const v = p.childForFieldName("value");
          if (k && v?.type === "identifier") names.push({ name: k.text, alias: v.text });
        }
      }
    }
    this.out.imports.push({
      ...(spec !== undefined ? { specifier: spec } : {}),
      form: "commonjs_require",
      importedNames: names,
      ...(ns ? { namespaceAlias: ns } : {}),
      isTypeOnly: false,
      isDynamicExpression: spec === undefined,
      summary: summarize(call.text),
      span: this.span(call),
    });
    return true;
  }

  private call(n: SyntaxNode, scope: Scope): void {
    const fn = n.childForFieldName("function");
    const args = n.childForFieldName("arguments");
    if (!fn) return;
    const argList = args ? kids(args).filter((a) => a.type !== "comment") : [];
    if (fn.type === "import" || (fn.type === "identifier" && fn.text === "require")) {
      // `const x = require("y")` is consumed by requireImport; this covers bare, nested and dynamic forms.
      const spec = argList.length >= 1 ? stringValue(argList[0]!) : undefined;
      this.out.imports.push({
        ...(spec !== undefined ? { specifier: spec } : {}),
        form: fn.type === "import" ? "dynamic_import" : "commonjs_require",
        importedNames: [],
        isTypeOnly: false,
        isDynamicExpression: spec === undefined,
        summary: summarize(n.text),
        span: this.span(n),
      });
      return;
    }
    if (!this.opts.calls) return;
    this.pushCall(fn, argList.length, scope, n, false);
  }

  private newExpr(n: SyntaxNode, scope: Scope): void {
    if (!this.opts.calls) return;
    const ctor = n.childForFieldName("constructor");
    const args = n.childForFieldName("arguments");
    if (!ctor) return;
    this.pushCall(ctor, args ? kids(args).filter((a) => a.type !== "comment").length : 0, scope, n, true);
  }

  private pushCall(callee: SyntaxNode, argumentCount: number, scope: Scope, whole: SyntaxNode, isNew: boolean): void {
    const chain = identifierChain(callee, "member_expression", "object", "property", IDENT);
    const receiver = !chain ? "other" : chain[0] === "super" ? "super" : chain.length === 1 ? "none" : chain[0] === "this" ? "this" : chain[0] === "super" ? "super" : "identifier";
    const fact: CallFact = {
      ...(scope.callerLocalId ? { callerLocalId: scope.callerLocalId } : {}),
      calleeSummary: summarize(chain ? chain.join(".") : computedCalleeSummary(callee, "member_expression", "property"), 80),
      ...(chain ? { calleeName: chain[chain.length - 1]!, memberChain: chain } : {}),
      receiver,
      argumentCount,
      callKind: isNew ? "constructor" : !chain ? (callee.type === "member_expression" ? "member" : "dynamic") : chain.length === 1 ? "direct" : "member",
      span: this.span(whole),
    };
    this.out.calls.push(fact);
  }
}

function nestedTypeChain(n: SyntaxNode | null): string[] | undefined {
  if (!n) return undefined;
  if (n.type === "type_identifier" || n.type === "identifier") return [n.text];
  if (n.type === "nested_type_identifier" || n.type === "member_expression") {
    const parts = n.text.split(".").map((p) => p.trim());
    return parts.every((p) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(p)) ? parts : undefined;
  }
  return undefined;
}
