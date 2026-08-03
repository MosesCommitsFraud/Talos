import type { LabelParts } from '@/lib/toolLabels';

/** Renders a label's styled pieces:
 *
 *  - the action verb turns red when the call failed. Success gets no colour —
 *    tinting it too would make every finished row shout and leave failures with
 *    nothing to stand out against. Red text IS the status; there is no icon.
 *  - the filename reads at full text brightness, because it is the part of the
 *    line a reader is actually looking for. Everything else stays muted.
 *
 *  A running call has no verb piece; its shimmer says it is still going. */
export const TOOL_PASS_CLASS = 'text-tool-pass';
export const TOOL_FAIL_CLASS = 'text-tool-fail';

export function ToolLabel({ parts, failed }: { parts: LabelParts; failed?: boolean }) {
  return (
    <>
      {parts.map((seg, i) => {
        if (seg.kind === 'name') {
          return (
            <span key={i} className="text-foreground">
              {seg.text}
            </span>
          );
        }
        if (seg.kind === 'verb' && failed) {
          return (
            <span key={i} className={TOOL_FAIL_CLASS}>
              {seg.text}
            </span>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );
}
