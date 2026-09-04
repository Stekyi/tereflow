import type { ReactNode } from 'react';

/**
 * Small markdown renderer for playbook bodies.
 *
 * Playbook content is authored by us and stored in our own database, so this
 * only needs to cover what we write: headings, paragraphs, lists, bold, and
 * links. Nothing is set with innerHTML, so there is no injection surface.
 */
export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.split('\n');
  let list: string[] = [];
  let para: string[] = [];
  let key = 0;

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul${key++}`} className="md-list">
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={`p${key++}`} className="md-p">
        {inline(para.join(' '))}
      </p>,
    );
    para = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^#{1,4}\s/.test(line)) {
      flushList();
      flushPara();
      const level = line.match(/^#+/)![0].length;
      const text = line.replace(/^#+\s*/, '');
      const Tag = (level <= 2 ? 'h2' : 'h3') as 'h2' | 'h3';
      blocks.push(
        <Tag key={`h${key++}`} className={`md-h${level <= 2 ? 2 : 3}`}>
          {inline(text)}
        </Tag>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      list.push(line.replace(/^\s*[-*]\s+/, ''));
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      list.push(line.replace(/^\s*\d+\.\s+/, ''));
      continue;
    }

    if (line.trim() === '') {
      flushList();
      flushPara();
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  flushList();
  flushPara();

  return <div className="md">{blocks}</div>;
}

/** Bold, code and links. Everything else renders as plain text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];

    if (token.startsWith('**')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      out.push(
        <code key={key++} className="md-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      // The label may itself contain brackets, e.g. "Regulation (EU) 2023/1115",
      // so anchor on the ']' rather than the first '('.
      const close = token.indexOf(']');
      const open = token.indexOf('(', close);
      const label = token.slice(1, close);
      const href = token.slice(open + 1, -1);
      const safe = /^https?:\/\//i.test(href) ? href : '#';
      out.push(
        <a key={key++} href={safe} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = m.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}
