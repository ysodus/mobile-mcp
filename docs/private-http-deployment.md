# Tailscale 私网 HTTP 部署与回滚

## 配置与请求校验

`MOBILEMCP_ALLOWED_HOSTS` 默认为未设置，HTTP 服务沿用 SDK 的默认策略。以 `--listen 127.0.0.1:3000` 启动时，默认 Host 白名单是 `localhost`、`127.0.0.1` 和 `[::1]`。stdio 忽略此变量。

启用时，将额外 DNS 主机名用逗号分隔，例如 `ss-macbook-air.tailf25270.ts.net` 或 `phone.example.net,tablet.example.net`。每项去掉首尾空白、转为小写，并按小写结果去重。主机名最多 253 个字符，至少两段，每段 1 至 63 个 ASCII 字母、数字或连字符，两端为字母或数字，最后一段以字母开头。配置中出现空值、空项、通配符、前导或尾随点、端口、URL、路径、用户信息、IP 字面量或 Unicode 字符时，进程在绑定端口前退出。只允许列出的完整主机名，子域名需要逐个列出。

启用额外白名单要求设置 `MOBILEMCP_AUTH` 并使用 loopback 监听。令牌至少包含一个 ASCII 字母、数字或 `-._~+/` 中的字符，之后可带尾部 `=`。空白、控制字符和其他格式错误会使进程在监听前退出。令牌值不会出现在配置错误中。使用 `--listen 127.0.0.1:3000` 或 `--listen '[::1]:3000'` 显式选择 IPv4 或 IPv6。启用白名单时，省略地址或使用 `localhost` 会直接绑定 `127.0.0.1`。所有 HTTP 监听端口都必须由十进制数字组成且在 `1–65535` 范围内。端口 `0` 会被拒绝，服务不会自动选择端口。

无论是否配置额外白名单，HTTP 服务都在 SDK 解析前检查原始请求字段。Host 必须恰好出现一次，使用合法的 DNS 主机名、标准点分十进制 IPv4 或括号 IPv6，可带范围为 `1–65535` 的端口。重复 Host 或 Origin、空端口、百分号编码以及其他畸形 authority 返回 HTTP `400`。SDK 仍对通过语法检查的 Host 进行精确主机名匹配，忽略大小写和请求 Host 中的端口。

Origin 校验浏览器请求的来源，与 Host 独立：

- 无 Origin 的 MCP 客户端可以继续鉴权。存在 Origin 时，必须恰好有一个 HTTP 或 HTTPS 来源值。用户信息、路径（包括尾部斜杠）、查询、片段、逗号列表、空值和 `null` 均返回 `400`。
- 合法 loopback Origin 继续按 SDK 的主机名规则校验。新增域名只接受浏览器序列化后的 `https://<小写主机名>`，即 HTTPS 默认端口 443，Origin 字符串省略默认端口。语法合法但未获准的 Host 或 Origin 返回 `403`。
- 两个头各自通过白名单即可，彼此无需相等。通过校验的 `/mcp` 请求仍需正确的 `Authorization: Bearer <token>`，缺失或错误时返回 `401`。服务不启用跨域 CORS，也不使用 `Forwarded`、`X-Forwarded-Host` 或 `X-Forwarded-Proto` 作校验依据。

## 从交付提交构建与打包

在新的目录中操作。将 `<FIX_COMMIT_SHA>` 替换为交付中给出的完整提交 SHA。交付使用 Apple Silicon、Node `v26.13.0` 和 npm `11.20.0`。使用仓库的 `package-lock.json`，其中 MCP Express 为 `2.0.2`、Node adapter 为 `2.1.2`、Server 和 Core 为 `2.4.0`、测试用 Client 为 `2.3.1`。

```bash
cd /Users/ysooo/Applications
git clone git@github.com:ysodus/mobile-mcp.git GrokMobileMCP-private-host
cd GrokMobileMCP-private-host
git checkout --detach '<FIX_COMMIT_SHA>'
npm ci
npm run build
package_dir="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$package_dir"
shasum -a 256 "$package_dir"/*.tgz
```

以下启动步骤使用该 checkout 的 `lib/index.js` 和 `npm ci` 安装的锁定依赖。npm 打包产物包含编译后的 CLI 和包元数据，安装 tarball 时应另行锁定安装环境的依赖解析。

## 审阅后的 Mac 切换

1. 保留原目录 `/Users/ysooo/Applications/GrokMobileMCP`、原 `1.0.16` 安装及原启动定义作为回滚副本。记录原可执行文件、工作目录、启动参数、服务管理方式和密钥注入方式，不记录令牌值。若需要另存程序文件，只备份包清单、锁文件和已安装的程序依赖。将含有凭据的原配置留在原位置。
2. 使用一个确认空闲的 loopback 端口启动新版本，将下方端口临时改成该端口，配合一次性测试令牌完成本地 HTTP 验证。检查监听地址及 `initialize` 返回的协议版本、服务器信息和 tools capability。验证后续 `tools/list`，并确认未知 Host、重复或畸形 Host/Origin 和错误令牌均被拒绝。
3. 在计划切换时，通过原服务管理方式停止旧实例，再用新版本占用原 loopback 端口。以下是启动模板。正式启动时由现有密钥管理方式注入 `MOBILEMCP_AUTH`，避免把实际令牌直接放进 shell 历史。

```bash
MOBILEMCP_ALLOWED_HOSTS='ss-macbook-air.tailf25270.ts.net' \
MOBILEMCP_AUTH='<BEARER_TOKEN>' \
node /Users/ysooo/Applications/GrokMobileMCP-private-host/lib/index.js --listen 127.0.0.1:3000
```

Tailscale Serve 继续把 tailnet 内的 HTTPS 流量转发到 `127.0.0.1:3000`，客户端地址为 `https://ss-macbook-air.tailf25270.ts.net/mcp`。此路径只需要现有私网 Serve，无需 Funnel、公网域名、公网 ADB 或 ACL 扩权。

## 回滚与验证范围

需要回滚时，停止新实例，恢复原启动定义和参数，使用原目录下的 `1.0.16` 和原密钥注入方式重新启动。移除新实例使用的 `MOBILEMCP_ALLOWED_HOSTS`，保留原 loopback 地址及端口。通过原有本地 MCP 客户端验证 Bearer 鉴权和 `initialize`。回滚后的旧版本会按原策略拒绝私网 Host。

自动化测试通过编译后的 CLI、系统分配的 loopback 测试端口和临时令牌验证 HTTP，并验证 stdio 握手。正式 Mac 服务切换后的本地复测、经 Tailscale Serve 的远端 `initialize`，以及从 Grok Bot 所在环境验证 tailnet 可达性和 MCP 握手，属于后续独立验证。设备端到端测试也未包含在本次交付中。后续通过 Grok Bot 核对设备列表和截图，并在横屏场景复核截图坐标提示与设备坐标。
