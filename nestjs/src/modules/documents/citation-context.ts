/** Expand presentation only. Retrieval offsets and saved evidence stay unchanged. */
export function expandCitationContext(text: string, start: number, end: number) {
  const previousSeparator = start >= 2 ? text.lastIndexOf('\n\n', start - 2) : -1;
  const separator = text.indexOf('\n\n', end);
  const paragraphEnd = separator === -1 ? text.length : separator;
  const left = previousSeparator === -1 ? 0 : previousSeparator + 2;
  if (paragraphEnd - left <= 1200) {
    const paragraph = text.slice(left, paragraphEnd).trim();
    const endsWithSentence = /[。！？.!?][”’」』）】"']*$/.test(paragraph);
    if (endsWithSentence || !/[。！？.!?]/.test(paragraph) || paragraphEnd === text.length)
      return paragraph;
  }

  const windowStart = Math.max(0, start - 900);
  const windowEnd = Math.min(text.length, end + 900);
  const endings = /(?:[。！？!?]|\.(?=\s|$))[”’」』）】"']*/g;
  let first: number | undefined, last: number | undefined;
  for (const match of text.slice(windowStart, windowEnd).matchAll(endings)) {
    const boundary = windowStart + match.index + match[0].length;
    if (boundary <= start) first = boundary;
    else if (boundary >= end) {
      last = boundary;
      break;
    }
  }
  return text.slice(first ?? (windowStart === 0 ? 0 : start),
    last ?? (windowEnd === text.length ? text.length : end)).trim();
}
