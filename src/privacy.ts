// Scrub seller-typed contact details from free text before storage or LLM calls.
// eBay listings rarely need this; Facebook Marketplace text often does.
export function redact(text: string) {
  return text
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email removed]")
    .replace(
      /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
      "[phone removed]",
    )
    .replace(
      /\b\d{1,6}\s+(?:[\w.-]+\s+){1,5}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|way|boulevard|blvd)\b[^\n,]*/gi,
      "[address removed]",
    );
}
