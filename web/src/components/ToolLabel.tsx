import type { LabelParts } from '@/lib/toolLabels';

/** Renders a label with its action verb tinted by outcome: green when the call
 *  passed, red when it failed. That colour IS the status indicator — there is no
 *  separate check/alert icon. A running call has no verb part and stays muted;
 *  its shimmer says it is still going. */
export const TOOL_PASS_CLASS = 'text-tool-pass';
export const TOOL_FAIL_CLASS = 'text-tool-fail';

export function ToolLabel({ parts, failed }: { parts: LabelParts; failed?: boolean }) {
  return (
    <>
      {parts.before}
      {parts.verb && (
        <span className={failed ? TOOL_FAIL_CLASS : TOOL_PASS_CLASS}>{parts.verb}</span>
      )}
      {parts.after}
    </>
  );
}
