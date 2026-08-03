import type { LabelParts } from '@/lib/toolLabels';

/** Renders a label whose action verb turns red when the call failed. Success is
 *  the norm and gets no colour at all — tinting it too would make every finished
 *  row shout, and leave failures with no contrast to stand out against. There is
 *  no check/alert icon either: red text IS the signal. A running call has no
 *  verb part; its shimmer says it is still going. */
export const TOOL_PASS_CLASS = 'text-tool-pass';
export const TOOL_FAIL_CLASS = 'text-tool-fail';

export function ToolLabel({ parts, failed }: { parts: LabelParts; failed?: boolean }) {
  return (
    <>
      {parts.before}
      {parts.verb && (failed ? <span className={TOOL_FAIL_CLASS}>{parts.verb}</span> : parts.verb)}
      {parts.after}
    </>
  );
}
