/** Python fact extraction from a Tree-sitter tree. Pure syntax; never imports or runs Python. */
import {
  DiagnosticCodes,
  type AdapterDiagnostic,
  type CallFact,
  type ImportFact,
  type ImportedName,
  type InheritanceFact,
  type SymbolFact,
  type SymbolKind,
} from "@codemap/contracts";
import { computedCalleeSummary, identifierChain, summarize, type SourceText, type SyntaxNode } from "@codemap/parser-runtime";

export interface PyExtractionResult {
  imports: ImportFact[];
  symbols: SymbolFact[];
  calls: CallFact[];
  inheritance: InheritanceFact[];
  diagnostics: AdapterDiagnostic[];
}

interface Scope {
  callerLocalId?: string;
  parentLocalId?: string;
  parentQualified?: string;
  /** Kind of the innermost enclosing declaration. */
  container: "module" | "class" | "function";
}

const IDENT = new Set(["identifier"]);
const DYNAMIC_IMPORT_FUNCS = new Set(["importlib.import_module", "__import__"]);

function kids(n: SyntaxNode): SyntaxNode[] {
  return n.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

function stringLiteral(n: SyntaxNode | undefined): string | undefined {
  if (!n || n.type !== "string") return undefined;
  const parts = kids(n);
  if (parts.some((p) => p.type === "interpolation")) return undefined;
  const content = parts.filter((p) => p.type === "string_content");
  if (parts.some((p) => p.type !== "string_content" && p.type !== "string_start" && p.type !== "string_end")) return undefined;
  return content.map((c) => c.text).join("");
}

export class PyExtractor {
  private readonly out: PyExtractionResult = { imports: [], symbols: [], calls: [], inheritance: [], diagnostics: [] };
  private nextId = 0;
  private depthWarned = false;

  constructor(
    private readonly src: SourceText,
    private readonly maxDepth: number,
    private readonly opts: { calls: boolean; inheritance: boolean },
  ) {}

  run(root: SyntaxNode): PyExtractionResult {
    this.visitChildren(root, { container: "module" }, 0, []);
    return this.out;
  }

  private span(n: SyntaxNode) {
    return this.src.span(n.startIndex, n.endIndex);
  }

  private visitChildren(n: SyntaxNode, scope: Scope, depth: number, decorators: string[]): void {
    for (const c of kids(n)) this.visit(c, scope, depth + 1, decorators);
  }

  private visit(n: SyntaxNode, scope: Scope, depth: number, decorators: string[] = []): void {
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
      case "import_from_statement":
        return this.importFrom(n);
      case "future_import_statement":
        return;
      case "decorated_definition": {
        const names = kids(n)
          .filter((c) => c.type === "decorator")
          .map((d) => {
            const expr = kids(d)[0];
            const target = expr?.type === "call" ? expr.childForFieldName("function") : expr;
            return identifierChain(target ?? null, "attribute", "object", "attribute", IDENT)?.join(".") ?? "decorator";
          });
        for (const d of kids(n)) if (d.type === "decorator") this.visitChildren(d, scope, depth, []);
        const def = n.childForFieldName("definition");
        if (def) this.visit(def, scope, depth + 1, names);
        return;
      }
      case "function_definition":
        return this.functionDef(n, scope, depth, decorators);
      case "class_definition":
        return this.classDef(n, scope, depth, decorators);
      case "expression_statement": {
        const assign = kids(n)[0];
        if (assign?.type === "assignment" && scope.container !== "function") this.assignment(assign, scope);
        return this.visitChildren(n, scope, depth, []);
      }
      case "call":
        this.call(n, scope);
        return this.visitChildren(n, scope, depth, []);
      case "lambda":
        return this.visitChildren(n, { ...scope, container: "function" }, depth, []);
      default:
        return this.visitChildren(n, scope, depth, []);
    }
  }

  private addSymbol(decl: SyntaxNode, nameNode: SyntaxNode | null, kind: SymbolKind, scope: Scope, modifiers: string[], fingerprint?: string): SymbolFact | undefined {
    if (!nameNode) return undefined;
    const name = nameNode.text;
    const fact: SymbolFact = {
      localId: `s${this.nextId++}`,
      name,
      qualifiedName: scope.parentQualified ? `${scope.parentQualified}.${name}` : name,
      symbolKind: kind,
      languageKind: decl.type,
      ...(fingerprint !== undefined ? { signatureFingerprint: fingerprint } : {}),
      span: this.span(decl),
      nameSpan: this.span(nameNode),
      ...(scope.parentLocalId ? { parentLocalId: scope.parentLocalId } : {}),
      // Python has no export statement; module-level names without a leading underscore are public by convention.
      exported: scope.container === "module" ? !name.startsWith("_") : "unknown",
      modifiers: [...new Set(modifiers)].sort(),
    };
    this.out.symbols.push(fact);
    return fact;
  }

  private functionDef(n: SyntaxNode, scope: Scope, depth: number, decorators: string[]): void {
    const nameNode = n.childForFieldName("name");
    const params = n.childForFieldName("parameters");
    const paramNames = params ? kids(params).filter((p) => p.type !== "comment") : [];
    const inClass = scope.container === "class";
    const mods = [...decorators.filter((d) => ["staticmethod", "classmethod", "property", "abstractmethod", "abc.abstractmethod"].includes(d)).map((d) => d.replace(/^abc\./, ""))];
    if (n.children.some((c) => c?.type === "async")) mods.push("async");
    if (decorators.length) mods.push("decorated");
    const kind: SymbolKind = inClass ? (nameNode?.text === "__init__" ? "constructor" : "method") : "function";
    const sym = this.addSymbol(n, nameNode, kind, scope, mods, `params:${paramNames.length}`);
    for (const p of paramNames) this.visit(p, scope, depth + 1);
    const body = n.childForFieldName("body");
    if (body) this.visitChildren(body, sym ? { callerLocalId: sym.localId, parentLocalId: sym.localId, parentQualified: sym.qualifiedName, container: "function" } : { ...scope, container: "function" }, depth, []);
  }

  private classDef(n: SyntaxNode, scope: Scope, depth: number, decorators: string[]): void {
    const sym = this.addSymbol(n, n.childForFieldName("name"), "class", scope, decorators.length ? ["decorated"] : []);
    const supers = n.childForFieldName("superclasses");
    if (supers) {
      for (const s of kids(supers)) {
        if (s.type === "keyword_argument" || s.type === "comment") continue;
        const chain = identifierChain(s, "attribute", "object", "attribute", IDENT);
        if (sym && chain && this.opts.inheritance) this.out.inheritance.push({ symbolLocalId: sym.localId, kind: "extends", targetName: chain.join("."), summary: summarize(s.text), span: this.span(s) });
        else if (sym && !chain) this.out.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "info", message: "base class is an expression; not recorded as inheritance", span: this.span(s) });
      }
      this.visitChildren(supers, scope, depth, []);
    }
    const body = n.childForFieldName("body");
    if (body) this.visitChildren(body, sym ? { callerLocalId: sym.localId, parentLocalId: sym.localId, parentQualified: sym.qualifiedName, container: "class" } : scope, depth, []);
  }

  private assignment(a: SyntaxNode, scope: Scope): void {
    const left = a.childForFieldName("left");
    if (left?.type !== "identifier") return;
    if (left.text === "__all__") return;
    const value = a.childForFieldName("right");
    if (value?.type === "call") {
      const fn = value.childForFieldName("function");
      const chain = identifierChain(fn, "attribute", "object", "attribute", IDENT)?.join(".");
      if (chain && DYNAMIC_IMPORT_FUNCS.has(chain)) {
        // `mod = importlib.import_module("x")` binds the module like an import.
        this.dynamicImport(value, chain, left.text);
        return;
      }
    }
    this.addSymbol(a, left, scope.container === "class" ? "field" : "variable", scope, a.childForFieldName("type") ? ["annotated"] : []);
  }

  private importStatement(n: SyntaxNode): void {
    for (const c of kids(n)) {
      if (c.type === "dotted_name") {
        const spec = c.text;
        this.out.imports.push({ specifier: spec, form: "static_import", importedNames: [], ...(spec.includes(".") ? {} : { namespaceAlias: spec }), isTypeOnly: false, isDynamicExpression: false, summary: summarize(`import ${spec}`), span: this.span(c) });
      } else if (c.type === "aliased_import") {
        const name = c.childForFieldName("name");
        const alias = c.childForFieldName("alias");
        if (!name) continue;
        this.out.imports.push({ specifier: name.text, form: "static_import", importedNames: [], ...(alias ? { namespaceAlias: alias.text } : {}), isTypeOnly: false, isDynamicExpression: false, summary: summarize(`import ${c.text}`), span: this.span(c) });
      }
    }
  }

  private importFrom(n: SyntaxNode): void {
    const mod = n.childForFieldName("module_name");
    let level = 0;
    let spec = "";
    if (mod?.type === "relative_import") {
      const prefix = kids(mod).find((k) => k.type === "import_prefix");
      level = prefix ? prefix.text.length : 0;
      spec = kids(mod).find((k) => k.type === "dotted_name")?.text ?? "";
    } else if (mod) spec = mod.text;
    const names: ImportedName[] = [];
    for (const c of n.childrenForFieldName("name")) {
      if (!c) continue;
      if (c.type === "dotted_name") names.push({ name: c.text });
      else if (c.type === "aliased_import") {
        const name = c.childForFieldName("name");
        const alias = c.childForFieldName("alias");
        if (name) names.push(alias ? { name: name.text, alias: alias.text } : { name: name.text });
      }
    }
    if (kids(n).some((c) => c.type === "wildcard_import")) names.push({ name: "*" });
    this.out.imports.push({
      specifier: spec,
      form: "static_import",
      importedNames: names,
      isTypeOnly: false,
      isDynamicExpression: false,
      ...(level ? { relativeLevel: level } : {}),
      summary: summarize(n.text),
      span: this.span(n),
    });
  }

  private dynamicImport(call: SyntaxNode, func: string, binding?: string): void {
    const args = call.childForFieldName("arguments");
    const first = args ? kids(args)[0] : undefined;
    const spec = stringLiteral(first);
    const relative = spec?.startsWith(".");
    this.out.imports.push({
      ...(spec !== undefined && !relative ? { specifier: spec } : {}),
      form: "dynamic_import",
      importedNames: [],
      ...(binding && spec !== undefined && !relative ? { namespaceAlias: binding } : {}),
      isTypeOnly: false,
      isDynamicExpression: spec === undefined || !!relative,
      summary: summarize(`${func}(${first?.text ?? ""})`),
      span: this.span(call),
    });
  }

  private call(n: SyntaxNode, scope: Scope): void {
    const fn = n.childForFieldName("function");
    if (!fn) return;
    const chain = identifierChain(fn, "attribute", "object", "attribute", IDENT);
    const joined = chain?.join(".");
    if (joined && DYNAMIC_IMPORT_FUNCS.has(joined)) {
      if (n.parent?.type !== "assignment") this.dynamicImport(n, joined);
      return;
    }
    if (!this.opts.calls) return;
    const args = n.childForFieldName("arguments");
    const argCount = args?.type === "argument_list" ? kids(args).filter((a) => a.type !== "comment").length : args ? 1 : 0;
    const receiver = !chain ? "other" : chain.length === 1 ? "none" : chain[0] === "self" || chain[0] === "cls" ? "this" : "identifier";
    this.out.calls.push({
      ...(scope.callerLocalId ? { callerLocalId: scope.callerLocalId } : {}),
      calleeSummary: summarize(joined ?? computedCalleeSummary(fn, "attribute", "attribute"), 80),
      ...(chain ? { calleeName: chain[chain.length - 1]!, memberChain: receiver === "this" ? ["this", ...chain.slice(1)] : chain } : {}),
      receiver,
      argumentCount: argCount,
      callKind: !chain ? (fn.type === "attribute" ? "member" : "dynamic") : chain.length === 1 ? "direct" : "member",
      span: this.span(n),
    });
  }
}
