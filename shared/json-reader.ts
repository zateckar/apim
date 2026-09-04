/**
 * A bounded JSON reader, not a general parser — the JSON half of design section 5.1's `always`
 * block, which is enforced in all three validation states and cannot be turned off by any policy.
 *
 * `JSON.parse` cannot do this job. It silently keeps the last of a set of duplicate keys, bounds
 * no nesting depth beyond the engine's own stack, and bounds no array length — so a body that is
 * legal JSON can still be a denial of service or an interpretation mismatch. Two parsers reading
 * `{"a":1,"a":2}` differently is the whole class of smuggling bug the `duplicateKeys` rule exists
 * to close: this gateway must see what the backend will see, or its validation verdict is about a
 * different document.
 *
 * The same call as `shared/xml.ts` makes for XML: refuse what we do not understand rather than
 * repair it.
 */

export class JsonError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    /** JSON pointer to the offending value, where one is known. */
    readonly path = "",
  ) {
    super(message);
    this.name = "JsonError";
  }
}

export interface JsonLimits {
  /** Nesting depth, counting the root as depth 1. */
  maxDepth: number;
  /** Elements in any one array. */
  maxArrayLength: number;
  /** Keys in any one object — the object-shaped counterpart of `maxArrayLength`. */
  maxObjectKeys: number;
  duplicateKeys: "reject" | "last-wins";
}

export const JSON_DEFAULT_LIMITS: JsonLimits = {
  maxDepth: 32,
  maxArrayLength: 10_000,
  maxObjectKeys: 5_000,
  duplicateKeys: "reject",
};

const enum C {
  Tab = 9,
  LF = 10,
  CR = 13,
  Space = 32,
  Quote = 34,
  Plus = 43,
  Comma = 44,
  Minus = 45,
  Dot = 46,
  Zero = 48,
  Nine = 57,
  Colon = 58,
  LBracket = 91,
  Backslash = 92,
  RBracket = 93,
  LBrace = 123,
  RBrace = 125,
}

/**
 * Parses `text` under `limits`. Throws `JsonError` on anything malformed or over a bound.
 *
 * Written as a hand-rolled scanner rather than `JSON.parse` plus a walk, because duplicate keys
 * are gone by the time a walk could see them, and because a walk would have to visit a structure
 * that was already fully materialised — which is the cost the depth and length bounds exist to
 * avoid paying.
 */
export function readJsonBounded(text: string, limits: Partial<JsonLimits> = {}): unknown {
  const l: JsonLimits = { ...JSON_DEFAULT_LIMITS, ...limits };
  let i = 0;
  const n = text.length;

  const fail = (message: string, path = ""): never => {
    throw new JsonError(message, i, path);
  };

  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === C.Space || c === C.Tab || c === C.LF || c === C.CR) i++;
      else break;
    }
  };

  const literal = (word: string, value: unknown): unknown => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return value;
    }
    return fail(`unexpected character "${text[i]}"`);
  };

  const readString = (): string => {
    // The opening quote is the caller's problem; this consumes it.
    i++;
    let out = "";
    let chunkStart = i;
    for (;;) {
      if (i >= n) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === C.Quote) {
        out += text.slice(chunkStart, i);
        i++;
        return out;
      }
      if (c === C.Backslash) {
        out += text.slice(chunkStart, i);
        i++;
        if (i >= n) fail("unterminated escape sequence");
        const esc = text[i]!;
        switch (esc) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(i + 1, i + 5);
            if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail(`invalid escape "\\${esc}"`);
        }
        i++;
        chunkStart = i;
        continue;
      }
      // Unescaped control characters are not legal JSON, and accepting them is how a header or a
      // log line ends up with a newline somebody else chose.
      if (c < 0x20) fail(`unescaped control character U+${c.toString(16).padStart(4, "0")} in a string`);
      i++;
    }
  };

  const readNumber = (): number => {
    const start = i;
    if (text.charCodeAt(i) === C.Minus) i++;
    if (i >= n) fail("truncated number");
    if (text.charCodeAt(i) === C.Zero) {
      i++;
    } else {
      const c = text.charCodeAt(i);
      if (c < C.Zero || c > C.Nine) fail("expected a digit");
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d < C.Zero || d > C.Nine) break;
        i++;
      }
    }
    if (i < n && text.charCodeAt(i) === C.Dot) {
      i++;
      const fracStart = i;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d < C.Zero || d > C.Nine) break;
        i++;
      }
      if (i === fracStart) fail("expected a digit after the decimal point");
    }
    if (i < n && (text[i] === "e" || text[i] === "E")) {
      i++;
      if (i < n && (text.charCodeAt(i) === C.Plus || text.charCodeAt(i) === C.Minus)) i++;
      const expStart = i;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d < C.Zero || d > C.Nine) break;
        i++;
      }
      if (i === expStart) fail("expected a digit in the exponent");
    }
    return Number(text.slice(start, i));
  };

  const readValue = (depth: number, path: string): unknown => {
    if (depth > l.maxDepth) fail(`nested deeper than ${l.maxDepth} levels`, path);
    ws();
    if (i >= n) fail("unexpected end of input", path);
    const c = text.charCodeAt(i);

    if (c === C.Quote) return readString();
    if (c === C.Minus || (c >= C.Zero && c <= C.Nine)) return readNumber();
    if (c === 116) return literal("true", true);
    if (c === 102) return literal("false", false);
    if (c === 110) return literal("null", null);

    if (c === C.LBracket) {
      i++;
      const out: unknown[] = [];
      ws();
      if (i < n && text.charCodeAt(i) === C.RBracket) {
        i++;
        return out;
      }
      for (;;) {
        if (out.length >= l.maxArrayLength) {
          fail(`array longer than ${l.maxArrayLength} elements`, path);
        }
        out.push(readValue(depth + 1, `${path}/${out.length}`));
        ws();
        if (i >= n) fail("unterminated array", path);
        const next = text.charCodeAt(i);
        if (next === C.Comma) {
          i++;
          continue;
        }
        if (next === C.RBracket) {
          i++;
          return out;
        }
        fail(`expected "," or "]" in an array`, path);
      }
    }

    if (c === C.LBrace) {
      i++;
      const out: Record<string, unknown> = {};
      let keys = 0;
      ws();
      if (i < n && text.charCodeAt(i) === C.RBrace) {
        i++;
        return out;
      }
      for (;;) {
        ws();
        if (i >= n || text.charCodeAt(i) !== C.Quote) fail("expected a quoted object key", path);
        const keyAt = i;
        const key = readString();
        if (++keys > l.maxObjectKeys) fail(`object with more than ${l.maxObjectKeys} keys`, path);
        if (Object.prototype.hasOwnProperty.call(out, key)) {
          if (l.duplicateKeys === "reject") {
            i = keyAt;
            fail(
              `duplicate object key "${key}": two parsers can disagree about which value wins, ` +
                "so the document is refused rather than interpreted",
              path,
            );
          }
        }
        ws();
        if (i >= n || text.charCodeAt(i) !== C.Colon) fail(`expected ":" after key "${key}"`, path);
        i++;
        // A key containing "/" or "~" would make an ambiguous JSON pointer; RFC 6901's escapes.
        const childPath = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        out[key] = readValue(depth + 1, childPath);
        ws();
        if (i >= n) fail("unterminated object", path);
        const next = text.charCodeAt(i);
        if (next === C.Comma) {
          i++;
          continue;
        }
        if (next === C.RBrace) {
          i++;
          return out;
        }
        fail(`expected "," or "}" in an object`, path);
      }
    }

    return fail(`unexpected character "${text[i]}"`);
  };

  const value = readValue(1, "");
  ws();
  if (i < n) fail("trailing content after the JSON value");
  return value;
}
