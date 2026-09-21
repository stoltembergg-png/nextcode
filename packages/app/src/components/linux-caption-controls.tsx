import type { Platform } from "@/context/platform"
import type { useLanguage } from "@/context/language"
import type { DesktopMenuAction } from "@/desktop-menu"

export function LinuxCaptionControls(props: {
  platform: Platform
  t: ReturnType<typeof useLanguage>["t"]
}) {
  const act = (action: DesktopMenuAction) => {
    void props.platform.runDesktopMenuAction?.(action)
  }
  return (
    <div class="linux-caption-controls shrink-0 flex" data-tauri-drag-region="false">
      <button type="button" class="linux-caption-btn" aria-label={props.t("desktop.menu.minimize")} onClick={() => act("window.minimize")} />
      <button type="button" class="linux-caption-btn" aria-label={props.t("desktop.menu.maximize")} onClick={() => act("window.toggleMaximize")} />
      <button type="button" class="linux-caption-btn linux-caption-btn-close" aria-label={props.t("desktop.menu.closeWindow")} onClick={() => act("window.close")} />
    </div>
  )
}
