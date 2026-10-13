const SESSION_TITLE_DATE_PREFIX = /^(?:(?:\[\d{6}\]|\d{6}-\d{3,}\s*\|)\s*)+/;

export function splitSessionTitleDatePrefix(value) {
  const text = String(value ?? '').trim();
  const matched = text.match(SESSION_TITLE_DATE_PREFIX)?.[0] || '';
  const first = matched.startsWith('[')
    ? matched.slice(0, 8)
    : matched.slice(0, matched.indexOf('|') + 1).replace(/\s*\|$/, ' |');
  return {
    prefix: first ? `${first} ` : '',
    title: text.slice(matched.length),
  };
}

export function sessionTitleDateKey(createdAt) {
  const date = new Date(createdAt);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function sessionTitleDatePrefix(createdAt, sequence) {
  const date = sessionTitleDateKey(createdAt).slice(-6);
  return sequence === undefined ? `[${date}] ` : `${date}-${String(sequence).padStart(3, '0')} | `;
}
