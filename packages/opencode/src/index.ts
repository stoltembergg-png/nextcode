import { hideBin } from "yargs/helpers"

const args = hideBin(process.argv)
const debugIndex = args.indexOf("debug")
if (debugIndex >= 0 && args[debugIndex + 1] === "omo-smoke") {
  const { prepareOmoSmokeEnvironment } = await import("./cli/cmd/debug/omo-bootstrap")
  prepareOmoSmokeEnvironment()
}

await import("./cli/main")
