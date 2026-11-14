import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.css";

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight: function (str, lang): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          "</code></pre>"
        );
      } catch (__) {}
    }

    return (
      '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + "</code></pre>"
    );
  },
});

// Keep wide tables scrollable on their own, without moving the surrounding answer.
md.renderer.rules.table_open = (tokens, index, options, _env, renderer) =>
  '<div class="markdown-table" role="region" aria-label="回答表格，可横向滚动" tabindex="0">' +
  renderer.renderToken(tokens, index, options);
md.renderer.rules.table_close = (tokens, index, options, _env, renderer) =>
  renderer.renderToken(tokens, index, options) + '</div>\n';

md.renderer.rules.text = (tokens, index, _options, env) => {
  // Normalize model-generated citation wrappers without enabling arbitrary HTML.
  // Code spans and code fences use separate renderers and retain their literals.
  const content = tokens[index].content.replace(/<sup\s*>\s*((?:\[\d+\]\s*)+)<\/sup\s*>/gi, '$1');
  const escaped = md.utils.escapeHtml(content);
  return escaped.replace(/\[(\d+)\]/g, (marker, number) =>
    env?.citationNumbers?.has(Number(number))
      ? '<button type="button" class="inline-citation" data-citation="' +
        Number(number) +
        '">' +
        marker +
        "</button>"
      : marker,
  );
};

export const renderMarkdown = (
  text: string,
  citationNumbers: number[] = [],
): string => {
  return md.render(text, { citationNumbers: new Set(citationNumbers) });
};
