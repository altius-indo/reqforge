import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type Ref, type PointerEvent as ReactPointerEvent } from "react"
import { STEP } from "@/state/panels"

/**
 * The resize handle on a side panel's inner edge (REQ-0064): a focusable vertical separator. Drag it, or use the
 * arrow keys (16 px; Left/Right move the edge, Up/Down widen/narrow), Home/End for the minimum/maximum width,
 * Enter to collapse, and double-click to restore the default width. Wide screens only (hidden below lg).
 * `dir` is +1 when dragging right widens the panel (sidebar), -1 when dragging left does (chat).
 */
// reqforge: implements REQ-0064
export function PanelHandle({
  label,
  controls,
  value,
  min,
  max,
  dir,
  onResize,
  onToggle,
  onReset,
  style,
  testId,
  ref,
}: {
  ref?: Ref<HTMLDivElement>
  label: string
  controls: string
  value: number
  min: number
  max: number
  dir: 1 | -1
  onResize: (w: number) => void
  onToggle: () => void
  onReset: () => void
  style: CSSProperties
  testId: string
}) {
  // the latest callback, so a drag in progress always clamps against the current maxima
  const resize = useRef(onResize)
  useEffect(() => {
    resize.current = onResize
  }, [onResize])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.focus()
    const x0 = e.clientX
    const w0 = value
    const body = document.body.style
    const prev = [body.cursor, body.userSelect]
    body.cursor = "col-resize"
    body.userSelect = "none"
    const move = (ev: PointerEvent) => resize.current(w0 + (ev.clientX - x0) * dir)
    const up = () => {
      ;[body.cursor, body.userSelect] = prev
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const by: Record<string, number> = { ArrowRight: STEP * dir, ArrowLeft: -STEP * dir, ArrowUp: STEP, ArrowDown: -STEP }
    if (e.key in by) onResize(value + by[e.key])
    else if (e.key === "Home") onResize(min)
    else if (e.key === "End") onResize(max)
    else if (e.key === "Enter") onToggle()
    else return
    e.preventDefault()
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label}: drag, or arrow keys; Enter collapses; double-click resets`}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      style={style}
      className="group absolute top-0 bottom-0 z-20 hidden w-2 cursor-col-resize touch-none outline-none lg:block"
    >
      <span className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 transition-colors group-hover:bg-primary/40 group-focus-visible:bg-primary group-active:bg-primary/60" />
    </div>
  )
}
