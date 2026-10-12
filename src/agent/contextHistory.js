/**
 * Normalize a linear conversation path before it reaches any model provider.
 * Tool-call assistant messages and their immediately following tool results are
 * one atomic transaction. Incomplete or orphaned transactions are omitted.
 */
function callIds(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  const seen = new Set();
  const ids = [];
  for (const call of message.tool_calls) {
    const id = String(call?.id || "");
    if (!id || seen.has(id)) return null; // duplicate IDs make the transaction invalid
    seen.add(id); ids.push(id);
  }
  return ids;
}

function toolCallId(message) {
  return String(message?.toolCallId || message?.tool_call_id || "");
}

/**
 * Return a protocol-safe subset of a path. Does not mutate source messages.
 * Non-tool assistant/user text is kept. An assistant with tool_calls is kept
 * only if every call has exactly one contiguous matching tool result.
 */
function normalizeContextHistory(messages) {
  const source = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const out = [];
  for (let i = 0; i < source.length; i++) {
    const message = source[i];
    if (message.role === "tool" || message.role === "toolResult") continue; // orphan unless consumed below
    const ids = callIds(message);
    if (ids === null) {
      // Malformed tool_calls message: omit it and its contiguous tool block.
      let j = i + 1;
      while (j < source.length && (source[j].role === "tool" || source[j].role === "toolResult")) j++;
      i = j - 1;
      continue;
    }
    if (!ids.length) {
      // Assistant tool_calls=[] is just a normal assistant message.
      out.push(message);
      continue;
    }
    const expected = new Set(ids);
    const results = [];
    const seen = new Set();
    let invalid = false;
    let j = i + 1;
    while (j < source.length && (source[j].role === "tool" || source[j].role === "toolResult")) {
      const result = source[j];
      const id = toolCallId(result);
      if (!expected.has(id) || seen.has(id)) {
        invalid = true;
      } else {
        seen.add(id); results.push(result);
      }
      j++;
    }
    if (!invalid && seen.size === expected.size) {
      out.push(message, ...results);
    }
    // Skip the complete contiguous tool block whether transaction was valid or not.
    i = j - 1;
  }
  return out;
}

module.exports = { normalizeContextHistory, callIds, toolCallId };
