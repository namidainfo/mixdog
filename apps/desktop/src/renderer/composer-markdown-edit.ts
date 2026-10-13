export type ComposerTextEdit = {
  value: string;
  start: number;
  end: number;
};

// Only line-leading Markdown markers are editing context, not inline punctuation.
const listPrefix = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/;

function lineStart(value: string, offset: number) {
  return value.lastIndexOf('\n', offset - 1) + 1;
}

export function composerNewlineEdit(value: string, start: number, end: number): ComposerTextEdit {
  const from = start === 0 ? 0 : lineStart(value, start);
  const lineEnd = value.indexOf('\n', start);
  const to = lineEnd < 0 ? value.length : lineEnd;
  const line = value.slice(from, to);
  const match = listPrefix.exec(line);
  let prefix = '';
  if (match) {
    if (
      start >= from + match[1].length + match[2].length &&
      !line.slice(match[0].length).trim() &&
      end <= to
    ) {
      // Exit an empty item in place, leaving a blank line rather than a new item.
      return { value: value.slice(0, from) + value.slice(to), start: from, end: from };
    }
    if (start >= from + match[0].length) {
      const marker = /^\d/.test(match[2])
        ? `${Number(match[2].slice(0, -1)) + 1}${match[2].slice(-1)}`
        : match[2];
      prefix = match[1] + marker + match[3];
    }
  }
  const caret = start + 1 + prefix.length;
  return {
    value: value.slice(0, start) + '\n' + prefix + value.slice(end),
    start: caret,
    end: caret,
  };
}

export function composerListIndentEdit(
  value: string,
  start: number,
  end: number,
  outdent: boolean
): ComposerTextEdit | null {
  const from = start === 0 ? 0 : lineStart(value, start);
  // A selection ending at the next line's start does not include that line.
  const last = end > start ? end - 1 : end;
  const nextBreak = value.indexOf('\n', last);
  const to = nextBreak < 0 ? value.length : nextBreak;
  const lines = value.slice(from, to).split('\n');
  if (!lines.every((line) => listPrefix.test(line))) return null;

  let offset = from;
  let delta = 0;
  let nextStart = start;
  let nextEnd = end;
  const edited = lines.map((line) => {
    const removed = outdent ? (/^(?:\t| {1,2})/.exec(line)?.[0].length ?? 0) : 0;
    const added = outdent ? 0 : 2;
    const shift = added - removed;
    const map = (position: number) => delta + (position < offset ? position : Math.max(offset, position - removed) + added);
    if (start >= offset) nextStart = map(start);
    if (end >= offset) nextEnd = map(end);
    offset += line.length + 1;
    delta += shift;
    return outdent ? line.slice(removed) : `  ${line}`;
  });
  return { value: value.slice(0, from) + edited.join('\n') + value.slice(to), start: nextStart, end: nextEnd };
}
