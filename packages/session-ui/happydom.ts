import { GlobalRegistrator } from "@happy-dom/global-registrator"
import h from "solid-js/h"
import { Fragment } from "solid-js/h/jsx-runtime"

GlobalRegistrator.register()

function createElement(type: string | ((props?: object) => unknown), props: object | null, ...children: unknown[]) {
  return h(type, props ?? {}, ...children)
}

;(globalThis as unknown as { React: { createElement: typeof createElement; Fragment: typeof Fragment } }).React = {
  createElement,
  Fragment,
}
;(globalThis as Record<string, unknown>).Fragment_8vg9x3sq = Fragment
