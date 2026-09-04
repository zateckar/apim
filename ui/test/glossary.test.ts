import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GLOSSARY, REQUIRED_TERMS, define } from "../src/lib/glossary.ts";

/**
 * The vocabulary is defined once and used everywhere (plan §9.4).
 *
 * The load-bearing test is the last one: it reads every `<Term name="…">` out of the source and
 * asserts it resolves. Without it the component fails open — an unknown term renders its children
 * and nothing looks wrong — and the portal quietly grows words with no definition.
 */

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("the glossary", () => {
  test("defines every term the portal cannot be used without", () => {
    const missing = REQUIRED_TERMS.filter((term) => !define(term));
    expect(missing).toEqual([]);
  });

  test("every definition is a sentence in plain language", () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.term.length, key).toBeGreaterThan(0);
      // A definition that is one word long is a synonym, not a definition.
      expect(entry.definition.split(/\s+/).length, key).toBeGreaterThan(8);
      expect(entry.definition.endsWith("."), `${key}: "${entry.definition}"`).toBe(true);
      expect(entry.definition[0], key).toBe(entry.definition[0]!.toUpperCase());
    }
  });

  test("every `see` points at a term that exists", () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      for (const other of entry.see ?? []) {
        expect(define(other), `${key} → ${other}`).not.toBeNull();
      }
    }
  });

  test("every key is lowercase, because that is what lookup normalises to", () => {
    // A key with a capital in it can never be found: `define()` lowercases its argument. Caught
    // here rather than by a `<Term>` that silently renders its children.
    for (const key of Object.keys(GLOSSARY)) expect(key).toBe(key.toLowerCase());
  });

  test("lookup is case-insensitive, so a heading and a sentence resolve alike", () => {
    expect(define("API")?.term).toBe("API");
    expect(define("Base Path")?.term).toBe("base path");
  });

  test("every <Term> used in the portal resolves", () => {
    const used = new Set<string>();
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<Term\s+name="([^"]+)"/g)) used.add(match[1]!);
    }
    // If this is zero the test is asserting nothing, which is the failure mode worth catching.
    expect(used.size).toBeGreaterThan(5);
    const unknown = [...used].filter((name) => !define(name));
    expect(unknown).toEqual([]);
  });
});
