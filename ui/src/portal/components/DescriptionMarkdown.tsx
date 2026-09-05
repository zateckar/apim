import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Render a description as sanitized Markdown. Shared by the Discover cards and
 * the API/Kafka detail modals so they render identically.
 *
 * Safety: react-markdown does NOT render raw HTML and we deliberately keep it
 * that way — no `rehype-raw`, no `dangerouslySetInnerHTML` — so a description
 * containing `<script>` / `<img onerror=…>` shows as literal text. We pass ONLY
 * `remarkGfm` (tables / strikethrough / autolinks). Links open in a new tab
 * with `rel="noopener noreferrer"`; react-markdown v10's `defaultUrlTransform`
 * already drops `javascript:` / `data:` URLs, so rendered hrefs are
 * http/https/mailto.
 *
 * Length clamping is the CALLER's job: the Discover cards clamp the source
 * first (so the `…` marker survives), while the detail modals render the full
 * description. The `.md-desc` wrapper carries the compact block styling.
 */
export function DescriptionMarkdown({ source }: { source: string }) {
  return (
    <div className="md-desc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
