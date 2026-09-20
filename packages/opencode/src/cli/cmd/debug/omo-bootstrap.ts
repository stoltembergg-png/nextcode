import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const configContent = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  omo: {
    enabled: true,
    preset: "auto",
    background: "allow",
    routing: "deterministic",
    verification: "tests",
    disabled_agents: [],
  },
  subagent_depth: 1,
})

export function prepareOmoSmokeEnvironment() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-omo-cli-"))
  const paths = {
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
    home: path.join(root, "home"),
    appData: path.join(root, "appdata"),
    localAppData: path.join(root, "localappdata"),
    tmp: path.join(root, "tmp"),
  }
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(paths.config, "opencode.json"), configContent)

  process.env.APPDATA = paths.appData
  process.env.HOME = paths.home
  process.env.LOCALAPPDATA = paths.localAppData
  process.env.USERPROFILE = paths.home
  process.env.OPENCODE_AUTH_CONTENT = "{}"
  process.env.OPENCODE_CONFIG_DIR = paths.config
  process.env.OPENCODE_CONFIG_CONTENT = configContent
  process.env.OPENCODE_DB = ":memory:"
  process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  process.env.OPENCODE_DISABLE_AUTOCOMPACT = "1"
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  process.env.OPENCODE_PURE = "1"
  process.env.OPENCODE_TEST_HOME = paths.home
  process.env.SEMIF_MODE = "off"
  process.env.TEMP = paths.tmp
  process.env.TMP = paths.tmp
  process.env.TMPDIR = paths.tmp
  process.env.XDG_CACHE_HOME = paths.cache
  process.env.XDG_CONFIG_HOME = paths.config
  process.env.XDG_DATA_HOME = paths.data
  process.env.XDG_STATE_HOME = paths.state
  delete process.env.OPENCODE_CONFIG

  process.once("exit", () => {
    rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 })
  })
}
