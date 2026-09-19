import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { encryptKey } from '@/lib/crypto';
import { imageConfigured, imageSource, imageMisroutedVendor, DEFAULT_IMAGE_MODEL, llmImage } from '@/lib/llm/image';
import { invalidatePlatformProviderCache } from '@/lib/llm/platform-providers';

// 生图接平台渠道。修的是一个「配了不生效」：/ops/ai 的「封面生图」能选渠道，
// 而读侧只看租户自己的豆包渠道 —— 超管配了平台生图 Key，用户点生成还是「未配置」。

let tenantId: string;

beforeEach(async () => {
  vi.unstubAllEnvs();
  invalidatePlatformProviderCache();
  await prisma.platformProvider.deleteMany();
  await prisma.modelProvider.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = tenant.id;
});

async function mkPlatform(opts: { vendor?: string; label?: string; isDefault?: boolean; routing?: Record<string, string>; model?: string } = {}) {
  const row = await prisma.platformProvider.create({
    data: {
      label: opts.label ?? '平台方舟',
      vendor: opts.vendor ?? 'doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKeyEnc: encryptKey('sk-platform'),
      model: opts.model ?? 'doubao-pro-32k',
      isDefault: opts.isDefault ?? false,
    },
  });
  if (opts.routing) {
    // routing 的口径是「渠道自己的 routing 里存 {fn: 自己的 id}」，与读侧一致
    const routing: Record<string, string> = {};
    for (const k of Object.keys(opts.routing)) routing[k] = row.id;
    await prisma.platformProvider.update({ where: { id: row.id }, data: { routing: JSON.stringify(routing) } });
  }
  invalidatePlatformProviderCache();
  return row;
}

async function mkTenantArk(model = 'doubao-pro-32k') {
  return prisma.modelProvider.create({
    data: {
      tenantId, label: '我的方舟', vendor: 'doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKeyEnc: encryptKey('sk-mine'), model, isDefault: true, status: 'ok',
    },
  });
}

describe('平台生图渠道真的会被用上', () => {
  it('什么都没配 → 未配置（不假装能生图）', async () => {
    expect(await imageConfigured(tenantId)).toBe(false);
    expect(await imageSource(tenantId)).toBeNull();
  });

  it('平台配了方舟默认渠道 → 租户零配置也能生图，来源记 platform', async () => {
    await mkPlatform({ isDefault: true });
    expect(await imageConfigured(tenantId)).toBe(true);
    expect(await imageSource(tenantId)).toBe('platform');
  });

  it('平台渠道显式指到「封面生图」时用它自己的模型；顺带命中的默认渠道用默认即梦模型', async () => {
    // 默认渠道（没指 image）：模型是文本模型，读侧必须换成默认即梦，否则拿文本模型去出图
    await mkPlatform({ isDefault: true, model: 'doubao-pro-32k' });
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([1, 2, 3]).toString('base64') }] }), { status: 200 });
    });
    await llmImage(tenantId, { prompt: 'p', size: '1024x1024' });
    expect(JSON.parse(calls[0].body).model).toBe(DEFAULT_IMAGE_MODEL);

    // 显式指到 image 的渠道：用它自己填的即梦版本
    await prisma.platformProvider.deleteMany();
    await mkPlatform({ model: 'doubao-seedream-5-0-260128', routing: { image: 'self' } });
    calls.length = 0;
    await llmImage(tenantId, { prompt: 'p', size: '1024x1024' });
    expect(JSON.parse(calls[0].body).model).toBe('doubao-seedream-5-0-260128');
  });

  it('租户自己的方舟渠道优先于平台渠道（平台不替已自备 Key 的人花钱）', async () => {
    await mkPlatform({ isDefault: true });
    await mkTenantArk();
    expect(await imageSource(tenantId)).toBe('byok');
  });
});

describe('指到非方舟渠道时不静默降级', () => {
  it('平台把「封面生图」指到 OpenAI → 不采纳，且说清楚为什么', async () => {
    await mkPlatform({ vendor: 'openai', label: '平台 OpenAI', routing: { image: 'self' } });
    expect(await imageConfigured(tenantId)).toBe(false);
    expect(await imageMisroutedVendor()).toBe('平台 OpenAI');

    const r = await llmImage(tenantId, { prompt: 'p', size: '1024x1024' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('平台 OpenAI');
    expect((r as { error: string }).error).toContain('水印');
  });

  it('非方舟的默认渠道也不会被顺手拿来生图', async () => {
    await mkPlatform({ vendor: 'deepseek', label: '平台 DeepSeek', isDefault: true });
    expect(await imageConfigured(tenantId)).toBe(false);
    // 没有被显式指到 image，所以不算「指错了家」，走的是普通的未配置提示
    expect(await imageMisroutedVendor()).toBeNull();
  });
});

describe('自定义 OpenAI 兼容端点也能生图（custom vendor）', () => {
  async function mkTenantCustom(opts: { baseUrl?: string; model?: string; routing?: Record<string, string>; isDefault?: boolean } = {}) {
    const row = await prisma.modelProvider.create({
      data: {
        tenantId, label: '我的代理', vendor: 'custom',
        baseUrl: opts.baseUrl ?? 'https://proxy.example.com/v1',
        apiKeyEnc: encryptKey('sk-custom'),
        model: opts.model ?? 'gemini-2.5-flash-image',
        isDefault: opts.isDefault ?? false, status: 'ok',
      },
    });
    if (opts.routing) {
      const routing: Record<string, string> = {};
      for (const k of Object.keys(opts.routing)) routing[k] = row.id;
      await prisma.modelProvider.update({ where: { id: row.id }, data: { routing: JSON.stringify(routing) } });
    }
    return row;
  }

  it('custom 显式路由到 image → 被采纳，来源 byok，body 不带 watermark，打到 custom 的 /images/generations', async () => {
    await mkTenantCustom({ baseUrl: 'https://proxy.example.com/v1', model: 'nano-banana-2', routing: { image: 'self' } });
    expect(await imageConfigured(tenantId)).toBe(true);
    expect(await imageSource(tenantId)).toBe('byok');

    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([1, 2, 3]).toString('base64') }] }), { status: 200 });
    });
    const r = await llmImage(tenantId, { prompt: 'p', size: '1024x1024' });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://proxy.example.com/v1/images/generations');
    const body = JSON.parse(calls[0].body);
    expect(body.model).toBe('nano-banana-2');
    expect(body.watermark).toBeUndefined();
    expect(body.image).toBeUndefined();
    expect(body.response_format).toBe('b64_json');
  });

  it('custom 存在但未显式路由 → 不被当兜底（custom 没有默认图模型，不假设它能生图）', async () => {
    await mkTenantCustom({ isDefault: true });
    expect(await imageConfigured(tenantId)).toBe(false);
    expect(await imageSource(tenantId)).toBeNull();
  });

  it('doubao 与 custom 同时存在且都未路由 → 仍走 doubao 兜底，body 带 watermark', async () => {
    await mkTenantCustom({ isDefault: true });
    await mkTenantArk('doubao-pro-32k');
    expect(await imageSource(tenantId)).toBe('byok');

    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([1, 2, 3]).toString('base64') }] }), { status: 200 });
    });
    await llmImage(tenantId, { prompt: 'p', size: '1024x1024' });
    expect(calls[0].url).toContain('ark.cn-beijing.volces.com');
    const body = JSON.parse(calls[0].body);
    expect(body.watermark).toBe(true);
    expect(body.model).toBe(DEFAULT_IMAGE_MODEL);
  });
});

describe('env 兜底仍然在（库里还没配时不能全站哑掉）', () => {
  it('显式配了 BEACON_IMAGE_LLM_MODEL 才开', async () => {
    vi.stubEnv('BEACON_IMAGE_LLM_API_KEY', 'k');
    expect(await imageConfigured(tenantId)).toBe(false); // 只有 key 没有 model：不假设它能生图
    vi.stubEnv('BEACON_IMAGE_LLM_MODEL', 'doubao-seedream-4-0-250828');
    expect(await imageConfigured(tenantId)).toBe(true);
  });
});
