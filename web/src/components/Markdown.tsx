import { memo, useMemo, type MouseEvent, type KeyboardEvent } from 'react';
import { renderMarkdown } from '../lib/markdown';
import { copyText } from '../lib/hooks';
import { useLina } from '../lib/lina';
import { cx } from '../lib/format';

/** Sanitized markdown with copyable code blocks and clickable `path/file.ts:12` references. */
export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text, { cache: !streaming }), [text, streaming]);
  const lina = useLina();

  const activate = (target: HTMLElement) => {
    const copy = target.closest<HTMLButtonElement>('[data-copy]');
    if (copy) {
      const code = copy.closest('.code-block')?.querySelector('code')?.textContent ?? '';
      void copyText(code).then((ok) => {
        copy.textContent = ok ? 'Copied' : 'Failed';
        copy.classList.add('is-done');
        setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('is-done'); }, 1400);
      });
      return true;
    }
    const ref = target.closest<HTMLElement>('[data-file]');
    if (ref && lina.store.get().view) {
      lina.openInspector('files', { filePath: ref.dataset.file ?? null });
      return true;
    }
    return false;
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => { if (activate(e.target as HTMLElement)) e.preventDefault(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).dataset.file) { e.preventDefault(); activate(e.target as HTMLElement); }
  };

  return <div className={cx('md', streaming && 'is-streaming', className)} onClick={onClick} onKeyDown={onKey} dangerouslySetInnerHTML={{ __html: html }} />;
});
