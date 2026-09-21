import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { linuxSidecarWrapper, stageOpencodeSidecar } from "./stage-opencode-sidecar"

describe("stage opencode sidecar", () => {
  test("linux wrapper is a shell script that execs usr/share", () => {
    const wrapper = linuxSidecarWrapper()
    expect(wrapper.startsWith("#!/bin/sh")).toBe(true)
    expect(wrapper).toContain("../share/opencode/opencode-cli")
    expect(wrapper).toContain("opencode-cli-real")
  })

  test("linux staging writes a wrapper in the externalBin slot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-sidecar-"))
    const source = path.join(dir, "opencode")
    writeFileSync(source, "ELF-FAKE")
    const destDir = path.join(dir, "binaries")
    const staged = stageOpencodeSidecar({
      host: "x86_64-unknown-linux-gnu",
      source,
      destDir,
    })
    expect(readFileSync(staged.wrapper, "utf8").startsWith("#!/bin/sh")).toBe(true)
    expect(readFileSync(staged.real, "utf8")).toBe("ELF-FAKE")
  })
})
