/**
 * @file cms-store.mts
 * @description Multi-tenant Sovereign CMS persistence & editorial workflow store.
 * Persists atomically to `cms-state.json` (tmp + rename) with zero external dependencies.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type ContentStatus =
  | 'draft'
  | 'in-review'
  | 'approved'
  | 'staging'
  | 'scheduled'
  | 'published';

export type ContentFormat = 'markdown' | 'gutenberg-blocks' | 'b8g-html';

export interface CmsSite {
  id: string;
  tenantId: string;
  name: string;
  domain: string;
  githubRepo: string;
  siteDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface CmsReview {
  id: string;
  reviewer: string;
  verdict: 'approved' | 'changes-requested';
  note: string;
  ts: string;
}

export interface CmsPage {
  id: string;
  siteId: string;
  tenantId: string;
  slug: string;
  title: string;
  format: ContentFormat;
  body: string;
  status: ContentStatus;
  scheduledAt?: string;
  publishedAt?: string;
  reviews: CmsReview[];
  createdAt: string;
  updatedAt: string;
}

interface CmsPersistedState {
  version: 1;
  sites: CmsSite[];
  pages: CmsPage[];
}

function cloneSite(site: CmsSite): CmsSite {
  return { ...site };
}

function clonePage(page: CmsPage): CmsPage {
  return {
    ...page,
    reviews: page.reviews.map((r) => ({ ...r })),
  };
}

function normalizeSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-{2,}/g, '-');
  return cleaned.length > 0 ? cleaned : 'index';
}

export class CmsStore {
  private readonly dataDir: string;
  private readonly stateFile: string;
  private state: CmsPersistedState;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.stateFile = path.join(this.dataDir, 'cms-state.json');
    mkdirSync(this.dataDir, { recursive: true });
    this.state = this.loadOrSeed();
  }

  private loadOrSeed(): CmsPersistedState {
    if (existsSync(this.stateFile)) {
      const raw = readFileSync(this.stateFile, 'utf8').trim();
      if (raw.length > 0) {
        const parsed = JSON.parse(raw) as Partial<CmsPersistedState>;
        if (Array.isArray(parsed.sites) && parsed.sites.length > 0) {
          return {
            version: 1,
            sites: parsed.sites,
            pages: Array.isArray(parsed.pages) ? parsed.pages : [],
          };
        }
      }
    }

    const now = new Date().toISOString();
    const seededSites: CmsSite[] = [
      {
        id: 'site_awesome_os',
        tenantId: 'awesome-os',
        name: 'Awesome-OS',
        domain: 'awesome-os.com',
        githubRepo: 'awesome-os/awesome-os.github.io',
        siteDir: 'sites/awesome-os.com',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'site_b8g_app',
        tenantId: 'awesome-os',
        name: 'B8G App',
        domain: 'b8g.app',
        githubRepo: 'awesome-os/b8g.app',
        siteDir: 'sites/b8g.app',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'site_lemanschik',
        tenantId: 'lemanschik',
        name: 'Lemanschik',
        domain: 'lemanschik.com',
        githubRepo: 'lemanschik/lemanschik.github.io',
        siteDir: 'sites/lemanschik.com',
        createdAt: now,
        updatedAt: now,
      },
    ];

    const seededPages: CmsPage[] = seededSites.map((site) => ({
      id: `page_welcome_${site.id.replace(/^site_/, '')}`,
      siteId: site.id,
      tenantId: site.tenantId,
      slug: 'welcome',
      title: `Welcome to ${site.name}`,
      format: 'markdown',
      body: `# Welcome to ${site.name}\n\nThis sovereign site is published to **${site.domain}** via \`${site.githubRepo}\`.\n`,
      status: 'published',
      publishedAt: now,
      reviews: [],
      createdAt: now,
      updatedAt: now,
    }));

    const initial: CmsPersistedState = {
      version: 1,
      sites: seededSites,
      pages: seededPages,
    };
    this.persist(initial);
    return initial;
  }

  private persist(nextState: CmsPersistedState = this.state): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmpFile = path.join(
      this.dataDir,
      `cms-state.${process.pid}.${randomUUID()}.tmp`,
    );
    writeFileSync(tmpFile, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    renameSync(tmpFile, this.stateFile);
  }

  private requirePage(pageId: string): CmsPage {
    const page = this.state.pages.find((p) => p.id === pageId);
    if (!page) {
      throw new Error(`CMS page not found: ${pageId}`);
    }
    return page;
  }

  listSites(tenantId?: string): CmsSite[] {
    const items = tenantId
      ? this.state.sites.filter((s) => s.tenantId === tenantId)
      : this.state.sites;
    return items.map(cloneSite);
  }

  createSite(input: {
    tenantId: string;
    name: string;
    domain: string;
    githubRepo: string;
    siteDir?: string;
  }): CmsSite {
    const domain = input.domain.trim().toLowerCase();
    if (!input.tenantId.trim()) {
      throw new Error('tenantId is required');
    }
    if (!domain) {
      throw new Error('domain is required');
    }
    const now = new Date().toISOString();
    const site: CmsSite = {
      id: `site_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      tenantId: input.tenantId.trim(),
      name: input.name.trim() || domain,
      domain,
      githubRepo: input.githubRepo.trim(),
      siteDir: input.siteDir?.trim() || `sites/${domain}`,
      createdAt: now,
      updatedAt: now,
    };
    this.state.sites.push(site);
    this.persist();
    return cloneSite(site);
  }

  getSite(siteId: string): CmsSite | undefined {
    const found = this.state.sites.find((s) => s.id === siteId);
    return found ? cloneSite(found) : undefined;
  }

  listPages(filter?: {
    tenantId?: string;
    siteId?: string;
    status?: ContentStatus;
  }): CmsPage[] {
    const items = this.state.pages.filter((p) => {
      if (filter?.tenantId !== undefined && p.tenantId !== filter.tenantId) {
        return false;
      }
      if (filter?.siteId !== undefined && p.siteId !== filter.siteId) {
        return false;
      }
      if (filter?.status !== undefined && p.status !== filter.status) {
        return false;
      }
      return true;
    });
    return items.map(clonePage);
  }

  getPage(pageId: string): CmsPage | undefined {
    const found = this.state.pages.find((p) => p.id === pageId);
    return found ? clonePage(found) : undefined;
  }

  createPage(input: {
    siteId: string;
    tenantId: string;
    slug: string;
    title: string;
    format?: ContentFormat;
    body: string;
  }): CmsPage {
    const site = this.state.sites.find((s) => s.id === input.siteId);
    if (!site) {
      throw new Error(`CMS site not found: ${input.siteId}`);
    }
    if (site.tenantId !== input.tenantId) {
      throw new Error(
        `Tenant mismatch: site ${input.siteId} belongs to ${site.tenantId}, not ${input.tenantId}`,
      );
    }

    const now = new Date().toISOString();
    const page: CmsPage = {
      id: `page_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      siteId: site.id,
      tenantId: site.tenantId,
      slug: normalizeSlug(input.slug),
      title: input.title.trim() || 'Untitled',
      format: input.format ?? 'markdown',
      body: input.body,
      status: 'draft',
      reviews: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.pages.push(page);
    this.persist();
    return clonePage(page);
  }

  updatePage(
    pageId: string,
    patch: {
      title?: string;
      slug?: string;
      body?: string;
      format?: ContentFormat;
      status?: ContentStatus;
      scheduledAt?: string;
    },
  ): CmsPage {
    const page = this.requirePage(pageId);
    if (patch.title !== undefined) {
      page.title = patch.title.trim();
    }
    if (patch.slug !== undefined) {
      page.slug = normalizeSlug(patch.slug);
    }
    if (patch.body !== undefined) {
      page.body = patch.body;
    }
    if (patch.format !== undefined) {
      page.format = patch.format;
    }
    if (patch.status !== undefined) {
      page.status = patch.status;
    }
    if (patch.scheduledAt !== undefined) {
      page.scheduledAt = patch.scheduledAt;
    }
    page.updatedAt = new Date().toISOString();
    this.persist();
    return clonePage(page);
  }

  submitForReview(pageId: string): CmsPage {
    const page = this.requirePage(pageId);
    page.status = 'in-review';
    page.updatedAt = new Date().toISOString();
    this.persist();
    return clonePage(page);
  }

  addReview(
    pageId: string,
    review: {
      reviewer: string;
      verdict: 'approved' | 'changes-requested';
      note: string;
    },
  ): CmsPage {
    const page = this.requirePage(pageId);
    const now = new Date().toISOString();
    const entry: CmsReview = {
      id: `rev_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      reviewer: review.reviewer.trim() || 'anonymous',
      verdict: review.verdict,
      note: review.note,
      ts: now,
    };
    page.reviews.push(entry);
    page.status = review.verdict === 'approved' ? 'approved' : 'draft';
    page.updatedAt = now;
    this.persist();
    return clonePage(page);
  }

  stagePage(pageId: string): CmsPage {
    const page = this.requirePage(pageId);
    if (page.status !== 'approved' && page.status !== 'staging') {
      throw new Error(
        `Page ${pageId} must be 'approved' or 'staging' before staging (current: '${page.status}')`,
      );
    }
    page.status = 'staging';
    page.updatedAt = new Date().toISOString();
    this.persist();
    return clonePage(page);
  }

  schedulePage(pageId: string, scheduledAtIso: string): CmsPage {
    const page = this.requirePage(pageId);
    if (page.status !== 'approved' && page.status !== 'staging') {
      throw new Error(
        `Page ${pageId} must be 'approved' or 'staging' before scheduling (current: '${page.status}')`,
      );
    }
    const parsedMs = Date.parse(scheduledAtIso);
    if (Number.isNaN(parsedMs)) {
      throw new Error(`Invalid scheduledAt ISO timestamp: ${scheduledAtIso}`);
    }
    page.status = 'scheduled';
    page.scheduledAt = new Date(parsedMs).toISOString();
    page.updatedAt = new Date().toISOString();
    this.persist();
    return clonePage(page);
  }

  markPublished(pageId: string): CmsPage {
    const page = this.requirePage(pageId);
    const now = new Date().toISOString();
    page.status = 'published';
    page.publishedAt = now;
    page.updatedAt = now;
    this.persist();
    return clonePage(page);
  }

  collectDueScheduledPages(nowIso?: string): CmsPage[] {
    const nowMs = nowIso !== undefined ? Date.parse(nowIso) : Date.now();
    if (Number.isNaN(nowMs)) {
      throw new Error(`Invalid nowIso timestamp: ${nowIso}`);
    }
    return this.state.pages
      .filter((p) => {
        if (p.status !== 'scheduled' || !p.scheduledAt) {
          return false;
        }
        const schedMs = Date.parse(p.scheduledAt);
        return !Number.isNaN(schedMs) && schedMs <= nowMs;
      })
      .map(clonePage);
  }
}
