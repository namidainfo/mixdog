const SESSION_TITLE_DATE_PREFIX = /^(?:\[\d{6}\]\s*)+/;

export function splitSessionTitleDatePrefix(value) {
  const text = String(value ?? '').trim();
  const matched = text.match(SESSION_TITLE_DATE_PREFIX)?.[0] || '';
  return {
    prefix: matched ? `${matched.slice(0, 8)} ` : '',
    title: text.slice(matched.length),
  };
}

export function sessionTitleDatePrefix(createdAt) {
  const date = new Date(createdAt);
  const year = String(date.getFullYear()).slice(-2).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `[${year}${month}${day}] `;
}
