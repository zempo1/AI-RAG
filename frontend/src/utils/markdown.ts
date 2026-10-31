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

md.renderer.rules.text = (tokens, index, _options, env) => {
  const escaped = md.utils.escapeHtml(tokens[index].content);
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
