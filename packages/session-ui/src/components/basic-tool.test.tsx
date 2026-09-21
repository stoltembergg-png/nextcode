import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { BasicTool } from "./basic-tool"

describe("BasicTool", () => {
  test("trigger contains the icon node when icon is set", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(
      () => <BasicTool icon="glasses" trigger={{ title: "Read", subtitle: "foo.ts" }} />,
      host,
    )
    const icon = host.querySelector('[data-slot="basic-tool-tool-icon"]')
    expect(icon).toBeTruthy()
    expect(host.querySelector("use")?.getAttribute("href")).toBe("#opencode-icon-glasses")
    expect(host.querySelector('[data-slot="basic-tool-tool-title"]')?.textContent).toContain("Read")
    dispose()
    host.remove()
  })
})
