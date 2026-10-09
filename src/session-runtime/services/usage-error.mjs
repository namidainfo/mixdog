// Keep transport evidence (including nested fetch causes) for presentation.
// This does not classify retries or change transport/security behavior.
export function usageErrorDetails(error) {
  const parts = [];
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    for (const value of [cause.message, cause.code]) {
      if (value != null && String(value) && !parts.includes(String(value))) parts.push(String(value));
    }
  }
  return parts.join(' · ') || String(error);
}
