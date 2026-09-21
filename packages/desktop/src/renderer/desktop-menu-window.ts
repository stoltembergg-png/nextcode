export type WindowHandle = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
}

export function runWindowMenuAction(action: string, window: WindowHandle): Promise<void> {
  if (action === "window.minimize") return window.minimize()
  if (action === "window.maximize") return window.toggleMaximize()
  if (action === "window.close") return window.close()
  return Promise.resolve()
}
