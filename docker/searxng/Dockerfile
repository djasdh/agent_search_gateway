# syntax=docker/dockerfile:1
#
# agent_search_gateway —— 定制 searxng 镜像
#
# 基础镜像为 searxng 官方镜像（AGPL-3.0）；本镜像在其之上叠加本仓库的
# 引擎/插件（searxng-ext/，同为 AGPL-3.0-or-later）。启动时由 entrypoint
# 用环境变量渲染 settings.yml，密钥不进镜像。
#
# 说明：searxng 只从 searx/engines、searx/plugins 加载，故必须把文件放进其源码树。
ARG SEARXNG_BASE=ghcr.io/searxng/searxng:latest
FROM ${SEARXNG_BASE}

# 本仓库扩展：额外引擎 + 配额台账插件（源码见仓库根 searxng-ext/，AGPL）
COPY searxng-ext/searx/engines/*.py /usr/local/searxng/searx/engines/
COPY searxng-ext/searx/plugins/quota.py /usr/local/searxng/searx/plugins/

# 配置模板 / 配额台账种子 / 启动包装
COPY docker/searxng/settings.template.yml /opt/agent-search/settings.template.yml
COPY docker/searxng/quota.config.json /opt/agent-search/quota.config.json
COPY docker/searxng/entrypoint.sh /opt/agent-search/entrypoint.sh
RUN chmod +x /opt/agent-search/entrypoint.sh

ENTRYPOINT ["/opt/agent-search/entrypoint.sh"]
