/**
 * @file wp-block-compiler.mts
 * @description Gutenberg block parser, Markdown/Block/B8G-HTML compiler, and staging preview writer.
 * Emits B8G022-compliant dark-glass HTML5 documents wrapped in `<b8g-section data-kind="cms-page">`.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const html = String.raw;

export interface WpBlock {
  name: string;
  attributes?: Record<string, unknown>;
  innerHTML?: string;
  innerBlocks?: WpBlock[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/-{2,}/g, '-');
  return cleaned.length > 0 ? cleaned : fallback;
}

function sanitizeSlugPath(rawSlug: string): string[] {
  const parts = rawSlug
    .split('/')
    .map((seg) => sanitizeSegment(seg, ''))
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
  return parts.length > 0 ? parts : ['index'];
}

function isWpBlockLike(value: unknown): value is WpBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function normalizeBlock(block: WpBlock): WpBlock {
  const out: WpBlock = { name: block.name };
  if (block.attributes && typeof block.attributes === 'object') {
    out.attributes = block.attributes;
  }
  if (typeof block.innerHTML === 'string') {
    out.innerHTML = block.innerHTML;
  }
  if (Array.isArray(block.innerBlocks) && block.innerBlocks.length > 0) {
    out.innerBlocks = block.innerBlocks.filter(isWpBlockLike).map(normalizeBlock);
  }
  return out;
}

/**
 * Parses WordPress Gutenberg comment blocks (`<!-- wp:paragraph -->...<!-- /wp:paragraph -->`,
 * `wp:heading`, `wp:code`, `wp:quote`, `wp:list`, nested blocks, self-closing blocks)
 * OR a JSON array of `WpBlock`.
 */
export function parseGutenbergCommentBlocks(raw: string): WpBlock[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(isWpBlockLike).map(normalizeBlock);
      }
    } catch {
      // Fall through to comment parser.
    }
  }

  const tokenRe =
    /<!--\s*(\/)?wp:([a-z0-9_-]+(?:\/[a-z0-9_-]+)?)(?:\s+(\{[\s\S]*?\}))?\s*(\/)?-->/g;

  interface StackFrame {
    block: WpBlock;
    innerChunks: string[];
    contentStart: number;
  }

  const roots: WpBlock[] = [];
  const stack: StackFrame[] = [];
  let cursor = 0;
  let foundAnyToken = false;

  for (const match of raw.matchAll(tokenRe)) {
    foundAnyToken = true;
    const fullMatch = match[0];
    const matchIndex = match.index ?? 0;
    const isClosing = match[1] === '/';
    const blockName = match[2];
    const attrJson = match[3];
    const isSelfClosing = match[4] === '/';

    if (stack.length > 0 && matchIndex > cursor) {
      stack[stack.length - 1].innerChunks.push(raw.slice(cursor, matchIndex));
    }

    let attributes: Record<string, unknown> | undefined;
    if (attrJson) {
      try {
        const parsedAttrs = JSON.parse(attrJson) as unknown;
        if (parsedAttrs && typeof parsedAttrs === 'object' && !Array.isArray(parsedAttrs)) {
          attributes = parsedAttrs as Record<string, unknown>;
        }
      } catch {
        // Ignore malformed attribute JSON.
      }
    }

    if (isSelfClosing) {
      const block: WpBlock = attributes
        ? { name: blockName, attributes, innerHTML: '' }
        : { name: blockName, innerHTML: '' };
      if (stack.length > 0) {
        const parent = stack[stack.length - 1].block;
        parent.innerBlocks = parent.innerBlocks ?? [];
        parent.innerBlocks.push(block);
      } else {
        roots.push(block);
      }
    } else if (!isClosing) {
      const block: WpBlock = attributes ? { name: blockName, attributes } : { name: blockName };
      stack.push({
        block,
        innerChunks: [],
        contentStart: matchIndex + fullMatch.length,
      });
    } else {
      // Closing tag: unwind until matching blockName
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].block.name === blockName) {
          const [frame] = stack.splice(i, 1);
          const innerHTML = frame.innerChunks.join('').trim();
          frame.block.innerHTML = innerHTML;
          if (stack.length > 0) {
            const parent = stack[stack.length - 1].block;
            parent.innerBlocks = parent.innerBlocks ?? [];
            parent.innerBlocks.push(frame.block);
          } else {
            roots.push(frame.block);
          }
          break;
        }
      }
    }

    cursor = matchIndex + fullMatch.length;
  }

  // Flush any unclosed frames gracefully.
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (cursor < raw.length) {
      frame.innerChunks.push(raw.slice(cursor));
      cursor = raw.length;
    }
    frame.block.innerHTML = frame.innerChunks.join('').trim();
    if (stack.length > 0) {
      const parent = stack[stack.length - 1].block;
      parent.innerBlocks = parent.innerBlocks ?? [];
      parent.innerBlocks.push(frame.block);
    } else {
      roots.push(frame.block);
    }
  }

  if (!foundAnyToken) {
    return [{ name: 'paragraph', innerHTML: `<p>${escapeHtml(trimmed)}</p>` }];
  }

  return roots;
}

function stripNamespace(name: string): string {
  const slash = name.indexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function renderWpBlock(block: WpBlock): string {
  const shortName = stripNamespace(block.name);
  const inner = (block.innerHTML ?? '').trim();
  const children = (block.innerBlocks ?? []).map(renderWpBlock).join('\n');

  switch (shortName) {
    case 'paragraph': {
      if (inner.startsWith('<p')) {
        return inner;
      }
      return html`<p>${inner}</p>`;
    }
    case 'heading': {
      const rawLevel = Number(block.attributes?.level ?? 2);
      const level = Number.isFinite(rawLevel)
        ? Math.min(6, Math.max(1, Math.trunc(rawLevel)))
        : 2;
      if (/^<h[1-6]\b/i.test(inner)) {
        return inner;
      }
      return html`<h${level}>${inner}</h${level}>`;
    }
    case 'code': {
      if (inner.startsWith('<pre')) {
        return inner;
      }
      return html`<pre class="wp-block-code"><code>${escapeHtml(inner)}</code></pre>`;
    }
    case 'quote': {
      if (inner.startsWith('<blockquote')) {
        return inner;
      }
      const content = [inner, children].filter(Boolean).join('\n');
      return html`<blockquote class="wp-block-quote">${content}</blockquote>`;
    }
    case 'list': {
      if (/^<[ou]l\b/i.test(inner)) {
        return inner;
      }
      const tag = block.attributes?.ordered === true ? 'ol' : 'ul';
      const content = [inner, children].filter(Boolean).join('\n');
      return html`<${tag} class="wp-block-list">${content}</${tag}>`;
    }
    default: {
      const content = [inner, children].filter(Boolean).join('\n');
      return html`<div class="wp-block" data-wp-block="${escapeHtml(block.name)}">${content}</div>`;
    }
  }
}

function renderInlineMarkdown(text: string): string {
  let out = escapeHtml(text);
  // Inline code first
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Links [label](href)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  // Bold **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic *text*
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length > 0) {
      out.push(html`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
      paragraphLines = [];
    }
  };

  const flushList = (): void => {
    if (listTag !== null) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const line of lines) {
    if (inCodeBlock) {
      if (line.trim().startsWith('```')) {
        const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
        out.push(html`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeLang = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fenceMatch = line.trim().match(/^```([a-zA-Z0-9_-]*)$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      inCodeBlock = true;
      codeLang = fenceMatch[1] ?? '';
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      out.push(html`<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      out.push('<hr />');
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      out.push(html`<blockquote><p>${renderInlineMarkdown(quoteMatch[1])}</p></blockquote>`);
      continue;
    }

    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listTag !== 'ul') {
        flushList();
        out.push('<ul>');
        listTag = 'ul';
      }
      out.push(html`<li>${renderInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listTag !== 'ol') {
        flushList();
        out.push('<ol>');
        listTag = 'ol';
      }
      out.push(html`<li>${renderInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    flushList();
    paragraphLines.push(line.trim());
  }

  if (inCodeBlock) {
    out.push(html`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushParagraph();
  flushList();

  return out.join('\n');
}

export function compilePageToHtml(page: {
  title: string;
  slug: string;
  format: 'markdown' | 'gutenberg-blocks' | 'b8g-html';
  body: string;
  domain?: string;
}): string {
  let renderedBody: string;
  if (page.format === 'gutenberg-blocks') {
    const blocks = parseGutenbergCommentBlocks(page.body);
    renderedBody = blocks.map(renderWpBlock).join('\n');
  } else if (page.format === 'b8g-html') {
    renderedBody = page.body.trim();
  } else {
    renderedBody = renderMarkdownToHtml(page.body);
  }

  const safeTitle = escapeHtml(page.title);
  const safeSlug = escapeHtml(page.slug);
  const safeDomain = escapeHtml(page.domain ?? 'sovereign.local');

  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} — ${safeDomain}</title>
  <style>
    :root {
      --bg: #070b14;
      --glass: rgba(15, 23, 42, 0.72);
      --border: rgba(148, 163, 184, 0.22);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-2: #a78bfa;
      --code-bg: rgba(2, 6, 23, 0.85);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at 15% 15%, rgba(56, 189, 248, 0.14), transparent 45%),
                  radial-gradient(circle at 85% 10%, rgba(167, 139, 250, 0.12), transparent 40%),
                  var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      line-height: 1.65;
      padding: 2rem 1.25rem;
    }
    main {
      max-width: 860px;
      margin: 0 auto;
    }
    .cms-card {
      background: var(--glass);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2rem 2.25rem;
      backdrop-filter: blur(18px);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
    }
    .cms-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.8rem;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.85rem;
      margin-bottom: 1.5rem;
    }
    .cms-domain {
      color: var(--accent);
      font-weight: 600;
      letter-spacing: 0.03em;
    }
    h1, h2, h3, h4, h5, h6 {
      color: #f8fafc;
      line-height: 1.25;
      margin-top: 1.5rem;
    }
    a { color: var(--accent); }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem;
      overflow-x: auto;
    }
    code {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 0.9em;
    }
    blockquote {
      margin: 1.25rem 0;
      padding: 0.5rem 1.1rem;
      border-left: 3px solid var(--accent-2);
      background: rgba(167, 139, 250, 0.08);
      border-radius: 0 8px 8px 0;
      color: #cbd5e1;
    }
  </style>
</head>
<body>
  <main>
    <article class="cms-card">
      <header class="cms-meta">
        <span class="cms-domain">${safeDomain}</span>
        <span class="cms-slug">/${safeSlug}</span>
      </header>
      <b8g-section data-kind="cms-page" data-surface="html-dom" data-liveness="static">
${renderedBody}
      </b8g-section>
    </article>
  </main>
</body>
</html>
`;
}

export function writeStagingPreview(
  site: { id: string; domain: string },
  page: {
    slug: string;
    title: string;
    format: 'markdown' | 'gutenberg-blocks' | 'b8g-html';
    body: string;
  },
  stagingRootDir: string,
): { filePath: string; relPath: string } {
  const safeDomain = sanitizeSegment(site.domain || site.id, 'site');
  const slugParts = sanitizeSlugPath(page.slug);
  const lastIndex = slugParts.length - 1;
  slugParts[lastIndex] = `${slugParts[lastIndex]}.html`;

  const relPath = [safeDomain, ...slugParts].join('/');
  const rootAbs = path.resolve(stagingRootDir);
  const filePath = path.resolve(rootAbs, safeDomain, ...slugParts);

  mkdirSync(path.dirname(filePath), { recursive: true });
  const compiled = compilePageToHtml({
    title: page.title,
    slug: page.slug,
    format: page.format,
    body: page.body,
    domain: site.domain,
  });

  const tmpFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpFile, compiled, 'utf8');
  renameSync(tmpFile, filePath);

  return { filePath, relPath };
}
