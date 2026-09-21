import { GlobalRegistrator } from "@happy-dom/global-registrator"
import h from "solid-js/h"

GlobalRegistrator.register()

function createElement(type: string | ((props?: object) => unknown), props: object | null, ...children: unknown[]) {
  return h(type, props ?? {}, ...children)
}

;(globalThis as unknown as { React: { createElement: typeof createElement } }).React = { createElement }
