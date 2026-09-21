import type { HotEntry, HotListAdapter } from './types';

// AIHOT 热点榜适配器：对接 https://aihot.news 的公开 REST API v1（匿名免 key）。
// 文档：https://aihot.news/agent?tab=api 。endpoint /api/v1/hot-topics 返回当前 AI 资讯热点榜
// （最多 10 条，每条带 rank / title / signalCount / links.aihot / links.original）。
//
// 与 60s 同档：开源自建/公开实例、无 SLA、单源失败仅该源回退 Mock，不拖垮 ingest。
// env 门控口径与 60s 完全一致（见 registry.hot60sEnabled）：
//   · 生产态：默认接真（免 key 拿真实 AI 热点），显式 BEACON_AIHOT='0' 才关。
//   · 非生产态（dev/test）：默认离线走 Mock，显式 BEACON_AIHOT='1' 才联网。
//   · BEACON_AIHOT_DISABLED='1' 任何环境都强制关。
//   · BEACON_AIHOT_BASE_URL 可指向自部署/镜像实例（默认官方 https://aihot.news/api/v1）。

const DEFAULT_BASE = 'https://aihot.news/api/v1';

type AiHotItem = {
  rank?: number;
  id?: string;
  title?: string;
  source?: { name?: string };
  links?: { aihot?: string; original?: string; story?: string };
  sourceCount?: number;
  signalCount?: number;
  participantCount?: number;
  sourceNames?: string[];
  latestAt?: string;
};

type AiHotResponse = {
  schemaVersion?: number;
  count?: number;
  items?: AiHotItem[];
};

export class AiHotAdapter implements HotListAdapter {
  readonly name = 'aihot-public';
  readonly kind = 'opensource' as const;
  readonly sources = ['aihot'];
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  }

  async fetchHot(source: string): Promise<HotEntry[]> {
    if (source !== 'aihot') return [];
    // 8s 超时：公开服务慢即视为不可用，快速熔断落 Mock，别拖住整轮 ingest
    const res = await fetch(`${this.baseUrl}/hot-topics`, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`aihot HTTP ${res.status}`);
    const data = (await res.json()) as AiHotResponse;
    const items = data?.items ?? [];
    // 过滤空标题项：避免在页面上显示空行、且让「示例数据」标签误消失。
    // 全空则抛错 → registry 逐源降级到 Mock，页面如实标「示例数据」。
    const entries = items
      .filter((it) => it.title && it.title.trim())
      .slice(0, 10) // API 本身上限 10 条
      .map((it, i) => ({
        source: 'aihot',
        // API 已给 rank，但防御性兜底：缺 rank 时按数组位置补
        rank: typeof it.rank === 'number' && it.rank > 0 ? it.rank : i + 1,
        title: it.title!.trim(),
        // 用站内阅读页做主链接（稳定、无需第三方登录）；原文放 extra 供追溯
        url: it.links?.aihot,
        // signalCount = 多少条信源在讨论这个事件，是最自然的「热度」指标
        heat: Number(it.signalCount) || 0,
        extra: {
          ...(it.links?.original ? { original: it.links.original } : {}),
          ...(it.source?.name ? { sourceName: it.source.name } : {}),
          ...(typeof it.sourceCount === 'number' ? { sourceCount: it.sourceCount } : {}),
          ...(typeof it.participantCount === 'number' ? { participantCount: it.participantCount } : {}),
          ...(it.links?.story ? { story: it.links.story } : {}),
        },
      }));
    if (entries.length === 0) throw new Error('aihot 空数据');
    return entries;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/hot-topics`, {
        signal: AbortSignal.timeout(6000),
        headers: { accept: 'application/json' },
      });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
