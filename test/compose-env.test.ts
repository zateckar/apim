import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The compose files name every setting its plane reads, and no setting it does not.
 *
 * Both files are the deployment contract in the form somebody actually runs, and both have drifted
 * from the code before: the request-log settings and the whole subscription-key group existed for
 * releases without appearing in either file, so the only way to find them was to read `config.ts`.
 * A variable missing from compose is a setting an operator cannot discover; a variable in compose
 * that nothing reads is a setting an operator will spend an afternoon on.
 *
 * The two exclusion lists below are the interesting part of this test. Each entry is a deliberate
 * omission with a reason, and adding one is a decision rather than a fix.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Every environment variable a source file reads. `intFromEnv`, `boolFromEnv` and `required` take
 * the name as a string and index `process.env` with it, so a regex over `process.env.X` alone would
 * miss most of the control plane's settings.
 */
function readsEnv(source: string): Set<string> {
  const found = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
    /\benv\.([A-Z][A-Z0-9_]*)/g,
    /\b(?:intFromEnv|boolFromEnv|required)\(\s*\n?\s*"([A-Z][A-Z0-9_]*)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  return found;
}

/** The keys of a compose service's `environment:` block — six spaces in, upper case, one per line. */
function composeEnv(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]!),
  );
}

interface Plane {
  file: string;
  sources: string[];
  /**
   * How many settings this plane reads, as of the change that added this test. A floor rather than
   * an exact count, so adding one is not a failing test — but low enough to catch the failure this
   * whole file is otherwise blind to: an extractor that has stopped matching (a renamed
   * `intFromEnv`, a moved `config.ts`) finds nothing, and every assertion below passes vacuously.
   */
  atLeast: number;
  /** Read by the plane, deliberately absent from its compose file, and why. */
  notInCompose: Record<string, string>;
}

const PLANES: Record<string, Plane> = {
  "control plane": {
    file: "docker-compose.control-plane.yml",
    sources: ["control-plane/src/config.ts", "control-plane/src/crypto.ts"],
    atLeast: 60,
    notInCompose: {
      PORT: "set by the image; the port inside the container, which the published port already fixes",
      DB_PATH: "set by the image, inside the volume",
      KEK_PATH: "set by the image, inside the volume",
      UI_DIST: "set by the image; a path in the image's own filesystem",
      INTEGRATIONS_FILE: "set by the image, inside the read-only config mount",
      TARGETS_FILE: "set by the image, inside the read-only config mount",
      NODE_ENV: "the test runner's, not a deployment setting",
      DEV_AUTH: "retired — setting it without AUTH_PROVIDERS is a startup failure that says so",
    },
  },
  "data plane": {
    file: "docker-compose.data-plane.yml",
    sources: ["data-plane/src/server.ts"],
    atLeast: 25,
    notInCompose: {
      GATEWAY_TOKEN: "the token as a value; the documented path is GATEWAY_TOKEN_FILE, because an " +
        "environment variable is visible to every process in the container and `docker inspect` prints it",
      GATEWAY_CONFIG_CACHE: "set by the image, inside the volume",
      GATEWAY_ARTIFACT_CACHE: "set by the image, inside the volume",
    },
  },
};

describe("the compose files and the environment contract", () => {
  for (const [plane, { file, sources, atLeast, notInCompose }] of Object.entries(PLANES)) {
    const declared = composeEnv(read(file));
    const reads = new Set<string>();
    for (const source of sources) for (const name of readsEnv(read(source))) reads.add(name);

    test(`${plane}: the settings are still being found`, () => {
      expect(reads.size).toBeGreaterThanOrEqual(atLeast);
      expect(declared.size).toBeGreaterThanOrEqual(atLeast - Object.keys(notInCompose).length);
    });

    test(`${plane}: every setting it reads is in ${file}`, () => {
      const missing = [...reads].filter((name) => !declared.has(name) && !(name in notInCompose));
      expect(missing.sort()).toEqual([]);
    });

    test(`${plane}: ${file} names nothing it does not read`, () => {
      // BUN_CONFIG_MAX_HTTP_REQUESTS is read by `assertOutboundCeiling` from a defaulted parameter
      // rather than from `process.env` directly, so the extractor sees it through `env.X`; anything
      // else here would be a variable the process ignores.
      const unused = [...declared].filter((name) => !reads.has(name));
      expect(unused.sort()).toEqual([]);
    });

    test(`${plane}: nothing is both declared and excluded`, () => {
      // An entry that says "deliberately not in compose" while sitting in compose is a comment that
      // has stopped being true, which is worse than either state on its own.
      const both = Object.keys(notInCompose).filter((name) => declared.has(name));
      expect(both).toEqual([]);
    });

    test(`${plane}: every exclusion is a setting that still exists`, () => {
      const stale = Object.keys(notInCompose).filter((name) => !reads.has(name));
      expect(stale).toEqual([]);
    });
  }

  test("both files pull the published image rather than building one", () => {
    // A `build:` section makes `docker compose up` build from a checkout when the image is not
    // already local, which is a different activity with different inputs — and the reason the
    // documented path used to need one. The images are what a deployment consumes.
    for (const { file } of Object.values(PLANES)) {
      const source = read(file);
      expect(source).toContain("image: ghcr.io/zateckar/apim/");
      expect(source).not.toMatch(/^\s*build:/m);
    }
  });

  test("the gateway repeats a default for every number it reads", () => {
    // `Number("")` is 0, not the default, and compose substitutes an empty string for an unset
    // variable — so a bare passthrough of an integer would hand the gateway a zero ceiling. The
    // control plane reads its integers with `intFromEnv`, which treats `""` as absent, and does not
    // need this.
    const source = read(PLANES["data plane"]!.file);
    const bare = [...source.matchAll(/^ {6}([A-Z][A-Z0-9_]*): \$\{[A-Z_]+:-\}$/gm)].map((m) => m[1]!);
    // The ones safe to pass straight through are read as a comparison or split on commas, never as
    // a number.
    expect(bare.sort()).toEqual([
      "DP_ACCESS_LOG",
      "DP_REUSE_PORT",
      "DP_TELEMETRY",
      "TRUSTED_PROXY_CIDRS",
      "TRUSTED_PROXY_CLIENT_CERT_HEADERS",
      "TRUST_SYSTEM_ROOTS",
    ]);
  });
});
