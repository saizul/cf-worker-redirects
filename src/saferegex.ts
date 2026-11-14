/**
 * Guard rails for user-supplied regular expressions.
 *
 * JavaScript regular expressions cannot be interrupted once they start, so a
 * true per-match timeout is impossible inside a Worker. Instead this module
 * combines several layers:
 *
 *  1. Static analysis rejects the classic catastrophic-backtracking shapes:
 *     nested quantifiers such as (a+)+, (a*)*, (a|b+)*, quantified groups that
 *     contain alternation with overlapping-looking branches, and backreferences.
 *  2. A length cap on the pattern itself.
 *  3. A length cap on the input the pattern is run against (see router).
 *  4. A per-request wall-clock budget across all regex rules (see router):
 *     once exceeded, remaining regex rules are skipped for that request.
 */

export const DEFAULT_MAX_PATTERN_LENGTH = 256;

export interface RegexCheck {
  ok: boolean;
  reason?: string;
}

interface GroupFrame {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

function isQuantifierStart(src: string, i: number): number {
  const ch = src[i];
  if (ch === "*" || ch === "+" || ch === "?") return 1;
  if (ch === "{") {
    const m = /^\{\d+(,\d*)?\}/.exec(src.slice(i));
    if (m) return m[0].length;
  }
  return 0;
}

/** Statically check a regex source for dangerous constructs. */
export function checkRegexSafety(source: string, maxLength = DEFAULT_MAX_PATTERN_LENGTH): RegexCheck {
  if (source.length === 0) return { ok: false, reason: "empty pattern" };
  if (source.length > maxLength) {
    return { ok: false, reason: `pattern longer than ${maxLength} characters` };
  }
  try {
    new RegExp(source);
  } catch (err) {
    return { ok: false, reason: `invalid regular expression: ${(err as Error).message}` };
  }

  const stack: GroupFrame[] = [{ hasQuantifier: false, hasAlternation: false }];
  let inClass = false;
  let lastClosed: GroupFrame | null = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1] ?? "";
      if (!inClass && /[1-9]/.test(next)) return { ok: false, reason: "backreferences are not allowed" };
      if (!inClass && next === "k" && source[i + 2] === "<") {
        return { ok: false, reason: "named backreferences are not allowed" };
      }
      i++;
      lastClosed = null;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      lastClosed = null;
      continue;
    }
    if (ch === "(") {
      stack.push({ hasQuantifier: false, hasAlternation: false });
      lastClosed = null;
      continue;
    }
    if (ch === ")") {
      const frame = stack.pop();
      if (!frame || stack.length === 0) return { ok: false, reason: "unbalanced parentheses" };
      if (frame.hasQuantifier) stack[stack.length - 1].hasQuantifier = true;
      lastClosed = frame;
      continue;
    }
    if (ch === "|") {
      stack[stack.length - 1].hasAlternation = true;
      lastClosed = null;
      continue;
    }
    const qLen = isQuantifierStart(source, i);
    if (qLen > 0) {
      const quant = source.slice(i, i + qLen);
      const unbounded = quant === "*" || quant === "+" || /,\}$/.test(quant) || /^\{\d+,\d{3,}\}$/.test(quant);
      if (lastClosed && quant !== "?" && lastClosed.hasQuantifier) {
        return { ok: false, reason: "nested quantifiers (for example (a+)+) are not allowed" };
      }
      if (lastClosed && unbounded) {
        if (lastClosed.hasAlternation) {
          return { ok: false, reason: "quantified alternation (for example (a|ab)*) is not allowed" };
        }
      }
      const top = stack[stack.length - 1];
      if (quant !== "?") top.hasQuantifier = true;
      if (lastClosed && lastClosed.hasQuantifier) top.hasQuantifier = true;
      i += qLen - 1;
      // A lazy/possessive marker directly after a quantifier.
      if (source[i + 1] === "?") i++;
      lastClosed = null;
      continue;
    }
    lastClosed = null;
  }
  return { ok: true };
}

/** Compile a checked regex. Throws when unsafe or invalid. */
export function compileSafeRegex(source: string, caseSensitive = false, maxLength?: number): RegExp {
  const check = checkRegexSafety(source, maxLength);
  if (!check.ok) throw new Error(check.reason);
  return new RegExp(source, caseSensitive ? "" : "i");
}
