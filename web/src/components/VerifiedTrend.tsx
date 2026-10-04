import { useState } from "react"
import type { VerificationSnapshot } from "@/api/types"
import { useVerificationHistory } from "@/state/queries"
import { pct, shortSha, shortTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const W = 600
const H = 96
const PAD_Y = 6

const points = (snaps: VerificationSnapshot[]) =>
  snaps.map((s, i) => ({
    x: snaps.length === 1 ? W / 2 : (i / (snaps.length - 1)) * W,
    y: PAD_Y + (1 - Math.max(0, Math.min(1, s.verified_ratio))) * (H - 2 * PAD_Y),
  }))

/** "+5 pts" / "−3 pts" / "no change" between two ratios */
function delta(a: number, b: number) {
  const d = Math.round((b - a) * 100)
  return d === 0 ? "no change" : `${d > 0 ? "+" : "−"}${Math.abs(d)} pts`
}

/**
 * Verified-criteria ratio over the last 30 evidence ingests (GET verification/history): an inline SVG area
 * chart on a fixed 0–100% scale, coloured with theme tokens so it works in light and dark mode, with a
 * per-ingest hover readout and a text alternative naming the latest value and its change.
 */
// reqforge: implements REQ-0034
export function VerifiedTrend() {
  const q = useVerificationHistory(30)
  const [hover, setHover] = useState<number | null>(null)
  const snaps = q.data ?? []
  if (q.error) return null
  const n = snaps.length
  const last = snaps[n - 1]
  const prev = snaps[n - 2]
  const first = snaps[0]
  const label = !n
    ? "Verified criteria trend: no evidence ingests yet"
    : `Verified criteria ratio over the last ${n} evidence ingest${n === 1 ? "" : "s"}: latest ${pct(last.verified_ratio)}` +
      (prev ? `, ${delta(prev.verified_ratio, last.verified_ratio)} since the previous ingest (${pct(prev.verified_ratio)})` : "") +
      (n > 2 ? `, ${delta(first.verified_ratio, last.verified_ratio)} since the first shown (${pct(first.verified_ratio)})` : "")
  const pts = points(snaps)
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  const area = n > 1 ? `${line} L${W},${H} L0,${H} Z` : ""
  const h = hover != null ? snaps[hover] : null
  const change = prev ? Math.round((last.verified_ratio - prev.verified_ratio) * 100) : 0

  return (
    <div
      data-testid="verif-trend"
      data-points={n}
      data-latest={last ? last.verified_ratio : ""}
      className="rounded-lg border bg-card px-3 py-2"
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
        <b className="font-semibold">Verified criteria trend</b>
        <span className="text-muted-foreground">last {n || 0} evidence ingest{n === 1 ? "" : "s"}</span>
        {last && (
          <span className="ml-auto inline-flex items-baseline gap-1.5">
            <b data-testid="verif-trend-latest" className="text-[15px] font-semibold tabular-nums">
              {pct(last.verified_ratio)}
            </b>
            {prev && (
              <span
                data-testid="verif-trend-delta"
                className={cn("tabular-nums", change > 0 ? "text-ok" : change < 0 ? "text-err" : "text-muted-foreground")}
              >
                {delta(prev.verified_ratio, last.verified_ratio)}
              </span>
            )}
          </span>
        )}
      </div>
      {!n ? (
        <p className="py-3 text-[12.5px] text-muted-foreground">No snapshots yet: each evidence ingest records one.</p>
      ) : (
        <div className="relative">
          <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-1.5">
            <div className="flex flex-col justify-between py-0.5 text-right text-[10.5px] leading-none text-muted-foreground tabular-nums" aria-hidden>
              <span>100%</span>
              <span>50%</span>
              <span>0%</span>
            </div>
            <div className="relative">
              <svg
                role="img"
                aria-label={label}
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                className="block h-[96px] w-full overflow-visible text-primary"
                onMouseLeave={() => setHover(null)}
              >
                <title>{label}</title>
                {[PAD_Y, H / 2, H - PAD_Y].map((y) => (
                  <line key={y} x1={0} x2={W} y1={y} y2={y} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                ))}
                {area && <path d={area} className="fill-current" fillOpacity={0.12} />}
                <path d={line} fill="none" className="stroke-current" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                {h && hover != null && (
                  <line x1={pts[hover].x} x2={pts[hover].x} y1={0} y2={H} className="stroke-muted-foreground" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                )}
                {/* hit targets wider than the marks: one band per snapshot */}
                {pts.map((p, i) => {
                  const half = n === 1 ? W / 2 : W / (n - 1) / 2
                  return (
                    <rect
                      key={i}
                      data-testid="verif-trend-point"
                      x={Math.max(0, p.x - half)}
                      y={0}
                      width={Math.min(W, p.x + half) - Math.max(0, p.x - half)}
                      height={H}
                      fill="transparent"
                      onMouseEnter={() => setHover(i)}
                    />
                  )
                })}
              </svg>
              {/* round markers as HTML so the stretched viewBox doesn't distort them */}
              {pts.map((p, i) =>
                i === n - 1 || i === hover ? (
                  <span
                    key={i}
                    aria-hidden
                    className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-primary"
                    style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}
                  />
                ) : null,
              )}
              {h && hover != null && (
                <div
                  data-testid="verif-trend-tip"
                  className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded-md border bg-popover px-2 py-1 text-[11.5px] whitespace-nowrap text-popover-foreground shadow-sm"
                  style={pts[hover].x / W > 0.6 ? { right: `${100 - (pts[hover].x / W) * 100}%` } : { left: `${(pts[hover].x / W) * 100}%` }}
                >
                  <b className="font-semibold tabular-nums">{pct(h.verified_ratio)}</b>{" "}
                  <span className="text-muted-foreground">
                    ({h.criteria.verified ?? 0}/{h.criteria_total}) · {shortTime(h.at)}
                    {h.commit ? ` · ${shortSha(h.commit)}` : ""}
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="mt-0.5 flex justify-between pl-[36px] text-[10.5px] text-muted-foreground tabular-nums" aria-hidden>
            <span>{shortTime(first.at)}</span>
            {n > 1 && <span>{shortTime(last.at)}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
