# §10 搜索评测报告

- 生成时间：2026-10-11T19:55:30
- 网关：`http://127.0.0.1:3100/mcp`　·　用例数：32　·　k=10
- 引擎策略：默认轮换（`fanout=1`），无结果静默降级

## 总体

| 指标 | 值 |
|---|---|
| 命中率 hit-rate@10 | **65.6%** (21/32) |
| precision@10 | **30.1%** |
| 平均延迟 | **1366 ms** |
| 平均返回条数 | 9.8 |
| 每查询消耗额度 | **1.22 次 API 调用** |

## 分类细分

| 类别 | 条数 | 命中率@10 | precision@10 | 平均延迟 | 平均条数 |
|---|---|---|---|---|---|
| 中文权威 (`zh-authority`) | 8 | 100.0% | 64.2% | 1327 ms | 9.9 |
| 中文 UGC (`zh-ugc`) | 8 | 62.5% | 32.5% | 1181 ms | 10 |
| 英文技术 (`en-tech`) | 8 | 75.0% | 15.1% | 1102 ms | 9.4 |
| 时效新闻 (`news`) | 8 | 25.0% | 8.8% | 1852 ms | 10 |

## 额度消耗（台账 used 差值）

| 引擎 | 调用数 |
|---|---|
| exaapi | 32 |
| tavily | 7 |
| **合计** | **39**（1.22/query） |

## 未命中样例（11/32）

- **[zh-u2]** `小红书 露营 装备 清单 推荐`
  - 期望：xiaohongshu.com
  - 实际：outdoors.tw, wildchild-life.com, tfcamping.net, 520zimeiti.cn, blog.pinkoi.com, chill.juksy.com, post.smzdm.com, blob.wenxiaobai.com, rankedlist.com, geekwandou.com
- **[zh-u4]** `贴吧 显卡 性价比 讨论 2025`
  - 期望：tieba.baidu.com
  - 实际：v2ex.com, v2ex.com, chiphell.com, v2ex.com, chiphell.com, chiphell.com, chiphell.com, linux.do, waptieba.baidu.com, linux.do
- **[zh-u8]** `知乎 上海 落户 政策 经验`
  - 期望：zhihu.com
  - 实际：92hukou.com, 01job.cn, k.sina.cn, hukou021.com, 71a.com, shhukou.cn, shengxinzhinan.com, shengxinzhinan.com, news.qq.com, chinaemail.com.cn
- **[en-t3]** `kubernetes pod pending unschedulable troubleshooting`
  - 期望：kubernetes.io
  - 实际：gremlin.com, alertigate.com, datadoghq.com, oncallready.dev, kubernetes.recipes, docs.cloud.google.com, oneuptime.com, cheveo.de, quickfix.cloud, docs.e2enetworks.com
- **[en-t7]** `postgresql jsonb GIN index performance`
  - 期望：postgresql.org
  - 实际：pgday.ch, sitepoint.com, medium.com, johal.in, cstsolution.com, exobench.ai, jusdb.com, monpg.app, johal.in, c-sharpcorner.com

## 全部用例明细

| # | id | 类别 | hit | P | 延迟 | 期望 | 实际域名 |
|---|---|---|---|---|---|---|---|
| 1 | zh-a1 | zh-authority | ✅ | 0.90 | 1794ms | dpm.org.cn, wikipedia.org | dpm.org.cn, dpm.org.cn, intl.dpm.org.cn, dpm.org.cn, ticket.dpm.org.cn, dpm.org.cn |
| 2 | zh-a2 | zh-authority | ✅ | 1.00 | 1284ms | gov.cn, npc.gov.cn | court.gov.cn, fgk.chinatax.gov.cn, gz.119.gov.cn, zjsxfj.gov.cn, hmo.gov.cn, sn.jcy.gov.cn |
| 3 | zh-a3 | zh-authority | ✅ | 0.70 | 1355ms | stats.gov.cn, gov.cn | stats.gov.cn, stats.gov.cn, stats.gov.cn, stats.gov.cn, stats.gov.cn, news.cctv.cn |
| 4 | zh-a4 | zh-authority | ✅ | 1.00 | 1297ms | gov.cn, cnsa.gov.cn, cas.cn | cnsa.gov.cn, cnsa.gov.cn, cnsa.gov.cn, gov.cn, gov.cn, cnsa.gov.cn |
| 5 | zh-a5 | zh-authority | ✅ | 0.20 | 1134ms | pbc.gov.cn, gov.cn | pbc.gov.cn, cn.investing.com, bankofchina.com, jrjgj.suzhou.gov.cn, bank.cngold.org, finance.sina.cn |
| 6 | zh-a6 | zh-authority | ✅ | 0.30 | 1296ms | moe.gov.cn | moe.gov.cn, moe.gov.cn, moe.gov.cn, news.cn, gaokao.eol.cn, big5.www.gov.cn |
| 7 | zh-a7 | zh-authority | ✅ | 0.70 | 1088ms | cma.gov.cn, weather.com.cn | m.nmc.cn, weather.cma.cn, cma.gov.cn, nmc.cn, cma.gov.cn, cma.gov.cn |
| 8 | zh-a8 | zh-authority | ✅ | 0.33 | 1368ms | wikipedia.org, baike.baidu.com | zh.wikipedia.org, learn.microsoft.com, baike.com, developer.aliyun.com, zh.wikipedia.org, 163.com |
| 9 | zh-u1 | zh-ugc | ✅ | 0.10 | 1299ms | zhihu.com | zhihu.com, autohome.com.cn, autohome.com.cn, chejiahao.autohome.com.cn, news.qq.com, donews.com |
| 10 | zh-u2 | zh-ugc | ❌ | 0.00 | 1084ms | xiaohongshu.com | outdoors.tw, wildchild-life.com, tfcamping.net, 520zimeiti.cn, blog.pinkoi.com, chill.juksy.com |
| 11 | zh-u3 | zh-ugc | ✅ | 0.60 | 1178ms | douban.com, movie.douban.com | movie.douban.com, da4k.com, web.archive.org, movie.douban.com, goodmovies.cn, douban.com |
| 12 | zh-u4 | zh-ugc | ❌ | 0.00 | 1195ms | tieba.baidu.com | v2ex.com, v2ex.com, chiphell.com, v2ex.com, chiphell.com, chiphell.com |
| 13 | zh-u5 | zh-ugc | ✅ | 0.10 | 1159ms | zhihu.com | shoelesscai.com, zhihu.com, m.hupu.com, bbs.hupu.com, bbs.hupu.com, m.kaoyan.com |
| 14 | zh-u6 | zh-ugc | ✅ | 1.00 | 1223ms | bilibili.com | bilibili.com, bilibili.com, bilibili.com, bilibili.com, bilibili.com, bilibili.com |
| 15 | zh-u7 | zh-ugc | ✅ | 0.80 | 1181ms | csdn.net, blog.csdn.net | blog.csdn.net, wenku.csdn.net, wenku.csdn.net, wenku.csdn.net, ask.csdn.net, jishuzhan.net |
| 16 | zh-u8 | zh-ugc | ❌ | 0.00 | 1130ms | zhihu.com | 92hukou.com, 01job.cn, k.sina.cn, hukou021.com, 71a.com, shhukou.cn |
| 17 | en-t1 | en-tech | ✅ | 0.30 | 1039ms | react.dev | react.dev, react.dev, blog.logrocket.com, react.dev, dev.to, react.wiki |
| 18 | en-t2 | en-tech | ✅ | 0.11 | 1217ms | docs.python.org | docs.python.org, stackoverflow.com, stackoverflow.com, stackoverflow.com, async-concurrency.com, pythontutorial.net |
| 19 | en-t3 | en-tech | ❌ | 0.00 | 1150ms | kubernetes.io | gremlin.com, alertigate.com, datadoghq.com, oncallready.dev, kubernetes.recipes, docs.cloud.google.com |
| 20 | en-t4 | en-tech | ✅ | 0.11 | 1179ms | typescriptlang.org | typescriptlang.org, stackoverflow.com, blog.logrocket.com, coddy.tech, coddy.tech, stanza.dev |
| 21 | en-t5 | en-tech | ✅ | 0.20 | 624ms | arxiv.org | arxiv.org, arxiv.org, research.google, proceedings.neurips.cc, papers.nips.cc, arxiv-txt.org |
| 22 | en-t6 | en-tech | ✅ | 0.11 | 1267ms | docs.docker.com | docs.docker.com, toolsops.dev, paulund.co.uk, docker.recipes, oneuptime.com, stackoverflow.com |
| 23 | en-t7 | en-tech | ❌ | 0.00 | 1269ms | postgresql.org | pgday.ch, sitepoint.com, medium.com, johal.in, cstsolution.com, exobench.ai |
| 24 | en-t8 | en-tech | ✅ | 0.38 | 1069ms | doc.rust-lang.org, rust-lang.org | doc.rust-lang.org, doc.rust-lang.org, rustfaq.org, users.rust-lang.org, rustfaq.org, rust.codeguides.io |
| 25 | news-1 | news | ✅ | 0.60 | 1994ms | openai.com, reuters.com, techcrunch.com | ithome.com, cls.cn, reddit.com, openai.com, openai.com, openai.com |
| 26 | news-2 | news | ❌ | 0.00 | 1811ms | reuters.com, cnbc.com, nvidia.com | cn.investing.com, kuku.baidu.com, threads.com, hk01.com, tikr.com, mezha.net |
| 27 | news-3 | news | ❌ | 0.00 | 2398ms | weather.com.cn, cma.gov.cn, cctv.com | m.nmc.cn, nmc.cn, tianqi.tianqijun.com, nmc.cn, chinanews.com.cn, nmc.cn |
| 28 | news-4 | news | ❌ | 0.00 | 1315ms | reuters.com, bloomberg.com | kuku.baidu.com, kuku.baidu.com, tw.stock.yahoo.com, cmegroup.com, news.qq.com, finance.sina.com.cn |
| 29 | news-5 | news | ❌ | 0.00 | 1722ms | caam.org.cn, reuters.com, gasgoo.com | news.qq.com, finance.sina.com.cn, zhuanlan.zhihu.com, binxin888.com, escaada-events.com, 163.com |
| 30 | news-6 | news | ❌ | 0.00 | 2293ms | reuters.com, gov.cn, thepaper.cn | actuia.com, cn.nytimes.com, datacamp.com, yeasy.gitbook.io, ibm.com, latincounsel.com |
| 31 | news-7 | news | ✅ | 0.10 | 1946ms | apple.com, theverge.com, reuters.com | youtube.com, bilibili.com, ithome.com, post.smzdm.com, fetnet.net, threads.com |
| 32 | news-8 | news | ❌ | 0.00 | 1338ms | fifa.com, espn.com, bbc.com | zn-kaiyun.com, cn-page-pgsoft.com, gigaset-ntp.com, m.dongqiudi.com, entry-hthsportsapp.com, m.dongqiudi.com |
