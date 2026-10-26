const TAGS = ['review', 'response', 'split', 'chat', 'goal-queue', 'goal-audit'];

/** Presentation only: the coordinator keeps and parses the original provider text. */
export function agentDisplayText(text: string, streaming = false): string {
  let hidden = false;
  const out = text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*lina-(review|response|split|chat|goal-queue|goal-audit)[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/gi,
    (_block, lead: string, _fence: string, tag: string, body: string) => {
      hidden = true;
      if (streaming || tag.toLowerCase() !== 'review') return lead;
      try {
        const review = JSON.parse(body);
        const verdict = typeof review.verdict === 'string' ? review.verdict.toLowerCase().replace(/[ -]/g, '_') : '';
        const approved = ['approve', 'approved', 'lgtm', 'accept', 'pass', 'ok'].includes(verdict);
        const changes = ['request_changes', 'changes_requested', 'reject', 'needs_changes', 'revise', 'fail'].includes(verdict);
        if (!approved && !changes) return lead;
        const lines = [`**Review: ${approved ? 'Approved' : 'Changes requested'}**`];
        if (typeof review.summary === 'string' && review.summary.trim()) lines.push(review.summary.trim());
        if (Array.isArray(review.findings)) for (const f of review.findings) {
          if (f && typeof f.title === 'string') lines.push(`- ${f.title}${typeof f.detail === 'string' && f.detail ? ': ' + f.detail : ''}`);
        }
        return lead + lines.join('\n\n');
      } catch { return lead; }
    });
  // A token stream can end midway through the fence's language name.
  const visible = streaming ? out.replace(/(^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*lina-([\w-]*)$/i, (block, lead: string, prefix: string) => TAGS.some((tag) => tag.startsWith(prefix.toLowerCase())) ? lead : block) : out;
  return visible.trim() || (hidden && !streaming ? 'Agent update recorded.' : '');
}
