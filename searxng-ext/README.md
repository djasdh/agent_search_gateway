# searxng-ext —— 本地 searxng 扩展(AGPL-3.0-or-later)

本目录是**我们自建/改造的 searxng 引擎与插件**,作为 **AGPL-3.0-or-later** 的独立分发
存在(完整许可文本见本目录 [`LICENSE`](./LICENSE))。

## 许可边界(重要)

- 这些文件是 **searxng(AGPL-3.0)的衍生作品**,因此**一律 AGPL-3.0-or-later**,
  每个文件顶部带 `SPDX-License-Identifier: AGPL-3.0-or-later`。
- 本仓库(`agent_search_gateway`)的**其余部分为 MIT**(见仓库根 `LICENSE`)。
  **两者不混用**:本目录整体按 AGPL 分发。
- 这些扩展**不作为上游贡献**提交给 searxng(不开 PR、不并入上游树);
  仅在此按 AGPL 分发,由使用者自行安装进自己的 searxng。
- 引擎代码只从 searxng 的 `searx/engines/` 加载(searxng 无外部引擎目录),
  故需复制/链接进 searxng 源码树才能运行(见下)。

## 内容

```
searx/engines/
  zhihu.py       知乎开放平台(站内 / 全网,一个模块两个 scope)
  tavily.py      Tavily(基于上游 PR #6499 的 vendored 代码,改为读环境变量)
  firecrawl.py   Firecrawl(可 keyless)
  youcom.py      You.com keyless MCP(不稳定,默认 disabled)
searx/plugins/
  quota.py       配额台账插件(pre_search 计数 + 剔除耗尽引擎)
```

> `exaapi` 是 **searxng 上游自带**(零代码),不在本目录;只需在 settings.yml 配置。
> 仓库根早先的 `searxng-tavily/` 是同一份 Tavily 代码的历史位置,本目录的
> `searx/engines/tavily.py` 为当前版本(已改为读 `TAVILY_API_KEY`)。

## 安装

```bash
# 复制进你的 searxng 源码树(默认 $HOME/Projects/searxng)
./searxng-ext/install.sh /path/to/searxng
```

然后在 searxng 的 `settings.yml` 里按 [`settings.example.yml`](./settings.example.yml)
启用相应引擎/插件,并重启 `searxng.service`。

## 密钥(绝不入库)

- `tavily.py` 读环境变量 `TAVILY_API_KEY`。
- `zhihu.py` 读环境变量 `ZHIHU_ACCESS_SECRET`。
- `exaapi` 的 key 由 searxng 的 `settings.yml` 提供(上游引擎只认 settings.yml)。

密钥放在**未跟踪**的 `settings.yml` 或 systemd 的 `EnvironmentFile` 里,**不要提交**。
