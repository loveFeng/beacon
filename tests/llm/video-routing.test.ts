import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { encryptKey } from '@/lib/crypto';
import { llmVideo } from '@/lib/llm/gateway';

// 视频理解路由：doubao 走方舟 video_url（带 fps），custom / gemini 走 image_url（Gemini OpenAI 兼容口径）。
// 真实 SQLite + stub fetch（chat/completions 端点），断言请求体里的视频内容块形状随 vendor 切换。

const OLD_ENV = { ...process.env };

async function mkTenant(plan = 'free') {
  return prisma.tenant.create({ data: { name: 't', plan } });
}

async function mkChannel(tenantId: string, opts: { vendor: string; baseUrl: string; model: string; routing?: boolean; isDefault?: boolean }) {
  const row = await prisma.modelProvider.create({
    data: {
      tenantId,
      label: `${opts.vendor}-${opts.model}`,
      vendor: opts.vendor,
      baseUrl: opts.baseUrl,
      apiKeyEnc: encryptKey('sk-test'),
      model: opts.model,
      isDefault: opts.isDefault ?? false,
      status: 'ok',
    },
  });
  if (opts.routing) {
    await prisma.modelProvider.update({
      where: { id: row.id },
      data: { routing: JSON.stringify({ video: row.id }) },
    });
  }
  return row;
}

const okChat = (text = '{"title":"t"}') =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

function lastBody(calls: { body: string }[]): Record<string, unknown> {
  return JSON.parse(calls[calls.length - 1].body);
}

function userContent(body: Record<string, unknown>): unknown[] {
  const msgs = body.messages as { role: string; content: unknown }[];
  const user = msgs.find((m) => m.role === 'user')!;
  return user.content as unknown[];
}

beforeEach(async () => {
  await prisma.llmCallLog.deleteMany();
  await prisma.modelProvider.deleteMany();
  await prisma.tenant.deleteMany();
  delete process.env.BEACON_QUOTA_ENABLED;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.env = { ...OLD_ENV };
});

describe('llmVideo 按渠道 vendor 切换视频内容块', () => {
  it('doubao 显式路由 → video_url 带 fps', async () => {
    const t = await mkTenant();
    await mkChannel(t.id, {
      vendor: 'doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-evolving',
      routing: true,
    });
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return okChat();
    });

    const r = await llmVideo(t.id, {
      system: { role: 'system', content: 's' },
      source: { kind: 'url', url: 'https://cdn/x.mp4' },
      fps: 2,
      facts: 'f',
    });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    const content = userContent(lastBody(calls));
    expect(content).toContainEqual({ type: 'video_url', video_url: { url: 'https://cdn/x.mp4', fps: 2 } });
  });

  it('gemini 显式路由 → image_url，不带 fps', async () => {
    const t = await mkTenant();
    await mkChannel(t.id, {
      vendor: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.8-pro',
      routing: true,
    });
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return okChat();
    });

    const r = await llmVideo(t.id, {
      system: { role: 'system', content: 's' },
      source: { kind: 'url', url: 'https://cdn/x.mp4' },
      fps: 2,
      facts: 'f',
    });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('generativelanguage.googleapis.com');
    const content = userContent(lastBody(calls));
    expect(content).toContainEqual({ type: 'image_url', image_url: { url: 'https://cdn/x.mp4' } });
    // 不应出现方舟的 video_url
    expect(content.some((c) => (c as { type?: string }).type === 'video_url')).toBe(false);
  });

  it('custom 显式路由 → image_url（内联 data:URI 也走 image_url）', async () => {
    const t = await mkTenant();
    await mkChannel(t.id, {
      vendor: 'custom',
      baseUrl: 'https://proxy.example.com/v1',
      model: 'nano-banana-2',
      routing: true,
    });
    const calls: { body: string }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push({ body: String(init.body) });
      return okChat();
    });

    const r = await llmVideo(t.id, {
      system: { role: 'system', content: 's' },
      source: { kind: 'inline', dataUri: 'data:video/mp4;base64,AAAA', bytes: 4, mime: 'video/mp4' },
      facts: 'f',
    });
    expect(r.ok).toBe(true);
    const content = userContent(lastBody(calls));
    expect(content).toContainEqual({ type: 'image_url', image_url: { url: 'data:video/mp4;base64,AAAA' } });
  });

  it('custom/gemini 存在但未显式路由 → 不自动挑选（仍回落 doubao 兜底或未配置）', async () => {
    const t = await mkTenant();
    await mkChannel(t.id, {
      vendor: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.8-pro',
      isDefault: true,
    });
    // 没有 doubao、也没有显式路由 → 未配置
    const r = await llmVideo(t.id, {
      system: { role: 'system', content: 's' },
      source: { kind: 'url', url: 'https://cdn/x.mp4' },
      facts: 'f',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_configured');
  });

  it('doubao 与 gemini 共存、都未路由 → 仍自动挑选 doubao（video_url）', async () => {
    const t = await mkTenant();
    await mkChannel(t.id, {
      vendor: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.8-pro',
      isDefault: true,
    });
    await mkChannel(t.id, {
      vendor: 'doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seed-evolving',
      isDefault: true,
    });
    const calls: { body: string }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push({ body: String(init.body) });
      return okChat();
    });

    const r = await llmVideo(t.id, {
      system: { role: 'system', content: 's' },
      source: { kind: 'url', url: 'https://cdn/x.mp4' },
      fps: 1,
      facts: 'f',
    });
    expect(r.ok).toBe(true);
    const content = userContent(lastBody(calls));
    expect(content.some((c) => (c as { type?: string }).type === 'video_url')).toBe(true);
  });
});
