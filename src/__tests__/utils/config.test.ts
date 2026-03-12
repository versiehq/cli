import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConfig, writeConfig, resolveRepoPath } from "../../utils/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "versie-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("returns null when no config file exists", () => {
    expect(readConfig(dir)).toBeNull();
  });

  it("returns null when config contains invalid JSON", () => {
    mkdirSync(join(dir, ".versie"));
    writeFileSync(join(dir, ".versie", "config.json"), "not json");
    expect(readConfig(dir)).toBeNull();
  });

  it("returns parsed config when file is valid", () => {
    mkdirSync(join(dir, ".versie"));
    writeFileSync(
      join(dir, ".versie", "config.json"),
      JSON.stringify({ liveBranch: "main", devBranch: "versie-dev" })
    );
    expect(readConfig(dir)).toEqual({ liveBranch: "main", devBranch: "versie-dev" });
  });
});

describe("writeConfig", () => {
  it("creates .versie directory and writes config", () => {
    writeConfig(dir, { liveBranch: "main", devBranch: "versie-dev" });
    expect(readConfig(dir)).toEqual({ liveBranch: "main", devBranch: "versie-dev" });
  });

  it("overwrites existing config", () => {
    writeConfig(dir, { liveBranch: "main", devBranch: "versie-dev" });
    writeConfig(dir, { liveBranch: "master", devBranch: "versie-dev" });
    expect(readConfig(dir)?.liveBranch).toBe("master");
  });
});

describe("resolveRepoPath", () => {
  it("returns provided path when given", () => {
    expect(resolveRepoPath("/my/project")).toBe("/my/project");
  });

  it("returns process.cwd() when undefined", () => {
    expect(resolveRepoPath(undefined)).toBe(process.cwd());
  });
});
