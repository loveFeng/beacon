import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchHotSource, fetchAllHot, hotSourceMode } from '@/lib/adapters/registry';
import { HOT_SOURCES } from '@/lib/constants';

// AIHOT 通道：开关语义（dev 默认离线 Mock / 生产默认接真）+ 逐源优雅降级。
// 全程 stub 全局 fetch，零真实网络（铁律）。setup 已把 NODE_ENV 置 'test'（非生产）、
// BEACON_AIHOT 置 '0'——即默认走 Mock。要走 AIHOT 联网路径的用例自己 stubEnv 打开。

// AIHOT /api/v1/hot-topics 的真实响应形状
const okPayload = {
  schemaVersion: 1,
  count: 2,
  items: [
    {
      rank: 1,
      id: 'cmu7hc2e80aavrogr7vbwhcjm',
      title: 'TypeSafe AI 发布 System One 模型 Jev',
      source: { name: 'X：OpenRouter (@OpenRouter)' },
      links: {
        aihot: 'https://aihot.news/items/cmu7hc2e80aavrogr7vbwhcjm',
        original: 'https://x.com/OpenRouter/status/2101061688338575739',
        story: 'https://aihot.virxact.com/story/379c3594',
      },
      sourceCount: 4,
      signalCount: 33,
      participantCount: 37,
      sourceNames: ['X：OpenRouter (@OpenRouter)', 'MarkTechPost（RSS）'],
      latestAt: '2026-09-20T20:44:02.000Z',
    },
    {
      rank: 2,
      id: 'cmu7jnd0b0fxtrogrch785oud',
      title: '谷歌 Gemini 被曝在安全测试中自主入侵三家公司系统',
      source: { name: 'X：Rohan Paul (@rohanpaul_ai)' },
      links: {
        aihot: 'https://aihot.news/items/cmu7jnd0b0fxtrogrch785oud',
        original: 'https://x.com/rohanpaul_ai/status/2101078460332720372',
      },
      sourceCount: 6,
      signalCount: 20,
      participantCount: 26,
      sourceNames: [],
      latestAt: '2026-09-20T20:20:56.000Z',
    },
  ],
};

function stubFetch(impl: (url: string) => Promise<unknown>) {
  const fn = vi.fn((input: RequestInfo | URL) => impl(String(input)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const okResponse = () => ({ ok: true, status: 200, json: async () => okPayload });

beforeEach(() => {
  // 显式钉死开关默认态，防外部 CI 环境注入干扰
  vi.stubEnv('BEACON_AIHOT_DISABLED', '');
  vi.stubEnv('BEACON_AIHOT_BASE_URL', '');
  vi.stubEnv('BEACON_DAILYHOT_BASE_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('aihot · 开关语义', () => {
  it("BEACON_AIHOT='0' 时纯 Mock，不发任何请求", async () => {
    vi.stubEnv('BEACON_AIHOT', '0');
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
    expect(r.entries.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("非生产态显式 BEACON_AIHOT='1' 时才走 AIHOT 真实数据，degraded=false", async () => {
    vi.stubEnv('BEACON_AIHOT', '1');
    stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('aihot-public');
    expect(r.degraded).toBe(false);
    expect(r.entries[0]).toMatchObject({
      source: 'aihot',
      rank: 1,
      title: 'TypeSafe AI 发布 System One 模型 Jev',
      heat: 33,
    });
    // 主链接用站内阅读页（稳定），原文放 extra
    expect(r.entries[0].url).toBe('https://aihot.news/items/cmu7hc2e80aavrogr7vbwhcjm');
    expect(r.entries[0].extra).toMatchObject({
      original: 'https://x.com/OpenRouter/status/2101061688338575739',
      sourceName: 'X：OpenRouter (@OpenRouter)',
      sourceCount: 4,
      participantCount: 37,
    });
  });

  it('非生产态默认离线：不设 BEACON_AIHOT 时纯 Mock、零网络（铁律：全新 clone 跑 dev）', async () => {
    vi.stubEnv('BEACON_AIHOT', undefined);
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('生产态默认接真：不设 BEACON_AIHOT 时走 AIHOT', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_AIHOT', undefined);
    stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('aihot-public');
    expect(r.degraded).toBe(false);
  });

  it("生产态显式 BEACON_AIHOT='0' 才关，回退 Mock、不发请求", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_AIHOT', '0');
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('mock-hot');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("BEACON_AIHOT_DISABLED='1' 任何环境都强制关（即便显式想开）", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_AIHOT', '1'); // 即便显式想开，硬关开关也压过它
    vi.stubEnv('BEACON_AIHOT_DISABLED', '1');
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('mock-hot');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('BEACON_AIHOT_BASE_URL 可指向自部署实例', async () => {
    vi.stubEnv('BEACON_AIHOT', '1');
    vi.stubEnv('BEACON_AIHOT_BASE_URL', 'http://my-aihot:8080/api/v1');
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('aihot-public');
    expect(r.degraded).toBe(false);
    // 请求 URL 指向自部署实例
    expect(fetchSpy.mock.calls[0][0]).toContain('http://my-aihot:8080/api/v1/hot-topics');
  });
});

describe('aihot · 逐源优雅降级', () => {
  beforeEach(() => vi.stubEnv('BEACON_AIHOT', '1'));

  it('单源请求失败 → 该源回退 Mock（isMock 语义），不 throw', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
    expect(r.entries.length).toBeGreaterThan(0); // 不开天窗
  });

  it('超时（AbortError）同样回退 Mock', async () => {
    stubFetch(() => Promise.reject(new DOMException('The operation was aborted', 'AbortError')));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
  });

  it('HTTP 非 200 回退 Mock', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
  });

  it('items 全空（无 title）回退 Mock', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, count: 0, items: [] }) }),
    );
    const r = await fetchHotSource('aihot');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
  });

  it('AIHOT 失败不影响其他源（如 weibo 仍走各自通道）', async () => {
    stubFetch((url) =>
      url.includes('aihot')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ code: 200, data: [{ title: '微博热搜一', hot_value: 1 }] }) }),
    );
    const bad = await fetchHotSource('aihot');
    const good = await fetchHotSource('weibo');
    expect(bad.via).toBe('mock-hot');
    expect(bad.degraded).toBe(true);
    // weibo 在 BEACON_HOT60S 未开时也落 Mock（默认态），但与 aihot 互不影响
    expect(good.entries.length).toBeGreaterThan(0);
  });

  it('完全离线时 fetchAllHot 全源通，aihot 落 Mock，绝不整体 throw', async () => {
    vi.stubEnv('BEACON_HOT60S', '0'); // 关掉 60s，让所有源都只靠 Mock 兜底
    stubFetch(() => Promise.reject(new TypeError('network unreachable')));
    const all = await fetchAllHot();
    expect(all).toHaveLength(HOT_SOURCES.length);
    const aihotResult = all.find((r) => r.source === 'aihot');
    expect(aihotResult?.via).toBe('mock-hot');
    expect(aihotResult?.degraded).toBe(true);
    expect(aihotResult?.entries.length).toBeGreaterThan(0);
  });
});

describe('aihot · 字段映射', () => {
  beforeEach(() => vi.stubEnv('BEACON_AIHOT', '1'));

  it('缺 rank 时按数组位置兜底，缺 links.original 时不进 extra', async () => {
    const payload = {
      schemaVersion: 1,
      count: 2,
      items: [
        { id: 'a', title: '无 rank 的条目', signalCount: 5, links: { aihot: 'https://aihot.news/items/a' } },
        { id: 'b', title: '无 signalCount 的条目', rank: 2, links: { aihot: 'https://aihot.news/items/b' } },
      ],
    };
    stubFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => payload }));
    const r = await fetchHotSource('aihot');
    expect(r.entries[0].rank).toBe(1); // 数组位置兜底
    expect(r.entries[0].heat).toBe(5);
    expect(r.entries[0].extra).not.toHaveProperty('original');
    expect(r.entries[1].heat).toBe(0); // 缺 signalCount → 0
  });
});
