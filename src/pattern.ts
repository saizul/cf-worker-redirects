/**
 * Prefix / wildcard pattern compiler and placeholder substitution.
 *
 * Patterns are compiled into regular expressions built only from escaped
 * literals and fixed fragments, so they are never vulnerable to catastrophic
 * backtracking regardless of user input.
 *
 * Syntax:
 *   /blog/*              "*" captures the rest of the path (may contain "/")
 *   /docs/:section/*     ":name" captures one path segment
 *   /shop                no wildcard: matches "/shop" and anything below "/shop/"
 */

export interface CompiledPattern {
  regex: RegExp;
  /** Capture names in positional order. Wildcards are named "splat" (last one wins for :splat). */
  names: string[];
  /** Literal text before the first token, used for specificity ordering. */
  literalPrefix: string;
  wildcardCount: number;
  paramCount: number;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export class PatternError extends Error {}

export function compilePrefixPattern(source: string, caseSensitive = false): CompiledPattern {
  if (!source.startsWith("/")) {
    throw new PatternError(`pattern must start with "/": ${source}`);
  }
  const names: string[] = [];
  let re = "^";
  let literalPrefix = "";
  let sawToken = false;
  let wildcardCount = 0;
  let paramCount = 0;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (ch === "*") {
      const isFinal = i === source.length - 1;
      const precededBySlash = re.endsWith("\\/");
      if (isFinal && precededBySlash) {
        // "/blog/*" also matches "/blog" itself (empty capture).
        re = re.slice(0, -2) + "(?:\\/(.*))?";
      } else {
        re += "(.*)";
      }
      names.push("splat");
      wildcardCount++;
      sawToken = true;
      i++;
      continue;
    }
    if (ch === ":" && (i === 0 || source[i - 1] === "/")) {
      const m = NAME_RE.exec(source.slice(i + 1));
      if (!m) throw new PatternError(`invalid parameter name at position ${i} in ${source}`);
      const name = m[0];
      if (name === "splat") throw new PatternError(`":splat" is reserved for wildcards in ${source}`);
      if (names.includes(name)) throw new PatternError(`duplicate parameter ":${name}" in ${source}`);
      names.push(name);
      re += "([^/]+)";
      paramCount++;
      sawToken = true;
      i += 1 + name.length;
      continue;
    }
    if (!sawToken) literalPrefix += ch;
    re += escapeRegExp(ch);
    i++;
  }

  if (wildcardCount === 0) {
    // Implicit sub-tree match: "/shop" -> "/shop", "/shop/", "/shop/a/b".
    if (re.endsWith("\\/")) re = re.slice(0, -2);
    re += "(?:\\/(.*))?";
    names.push("splat");
  }
  re += "$";

  return {
    regex: new RegExp(re, caseSensitive ? "" : "i"),
    names,
    literalPrefix: caseSensitive ? literalPrefix : literalPrefix.toLowerCase(),
    wildcardCount,
    paramCount,
  };
}

export interface Captures {
  positional: string[];
  named: Record<string, string>;
}

export function capturesFromMatch(match: RegExpExecArray, names?: string[]): Captures {
  const positional = match.slice(1).map((v) => v ?? "");
  const named: Record<string, string> = {};
  if (names) {
    names.forEach((n, idx) => {
      named[n] = positional[idx] ?? "";
    });
  }
  if (match.groups) {
    for (const [k, v] of Object.entries(match.groups)) named[k] = v ?? "";
  }
  return { positional, named };
}

/**
 * Replace $1..$99, $<name>, :name and $$ in a destination template.
 * Unknown ":word" sequences (for example "https:" or ":8080") are left alone.
 */
export function substitute(template: string, captures: Captures): string {
  return template.replace(
    /\$\$|\$<([A-Za-z_][A-Za-z0-9_]*)>|\$(\d{1,2})|:([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, angle: string | undefined, num: string | undefined, colon: string | undefined) => {
      if (whole === "$$") return "$";
      if (angle !== undefined) return captures.named[angle] ?? "";
      if (num !== undefined) {
        const idx = Number(num) - 1;
        return idx >= 0 && idx < captures.positional.length ? captures.positional[idx] : "";
      }
      if (colon !== undefined && Object.prototype.hasOwnProperty.call(captures.named, colon)) {
        return captures.named[colon];
      }
      return whole;
    },
  );
}

/** Placeholders referenced by a destination template. */
export function referencedPlaceholders(template: string): { positional: number[]; named: string[] } {
  const positional: number[] = [];
  const named: string[] = [];
  const re = /\$\$|\$<([A-Za-z_][A-Za-z0-9_]*)>|\$(\d{1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m[1]) named.push(m[1]);
    else if (m[2]) positional.push(Number(m[2]));
  }
  return { positional, named };
}
