import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/** Assistant message body. Memoized — re-renders only when the text changes,
 *  which matters while sibling messages stream. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body text-[15px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
