# Chrome Web Store Listing Draft

Replace `SUPPORT_EMAIL` with a monitored support address before submitting this listing.

## Store name

ResuMatch Local Workbench

## Short description

在本机筛选 Boss 岗位并生成可审核的打招呼语草稿；不自动投递或发送消息。

## Detailed description

ResuMatch Local Workbench 是一个 Local-first 招聘辅助工具。它在用户已登录并主动浏览的 Boss 页面中读取岗位和聊天信息，将结果保存到用户电脑的本地工作台，用于岗位检索、候选筛选、历史回复统计和打招呼语草稿生成。

主要能力：

- 按职位、城市和筛选条件检索岗位，并导入本地工作台。
- 基于岗位内容生成可编辑的打招呼语草稿。
- 在用户主动触发后，整理历史入站回复并生成本地统计。
- 仅在用户电脑的 `127.0.0.1` 本地服务和 SQLite 数据库中处理数据。

边界：

- 不自动投递职位。
- 不自动发送打招呼语或任何聊天消息。
- 不绕过登录、验证码、访问限制或任何平台风控机制。
- 云端 AI 和匿名遥测均默认关闭。

## Single purpose

帮助用户在自己的本机工作台中整理其主动浏览的招聘岗位，并生成可由用户自行审核的打招呼语草稿。

## Permission justifications

| Permission | Reason |
| --- | --- |
| `activeTab` | 用户点击扩展后，读取当前已打开且已登录的 Boss 页面。 |
| `tabs` | 用户主动发起批量检索时，创建和关闭非激活的 Boss 搜索标签页。 |
| `scripting` | 确保内容脚本能够在用户主动使用的受支持页面上运行。 |
| `https://www.zhipin.com/*` | 仅用于读取用户在 Boss 页面中主动浏览的岗位和聊天内容。 |
| `http://127.0.0.1:8788/*` | 仅用于与同一电脑上的 ResuMatch 本地工作台通信。 |

## Data handling declaration

该扩展会在用户主动触发功能后处理岗位信息、简历相关信息和聊天信息。这些数据默认只保存在用户本机 SQLite 数据库中，用于提供检索、筛选、统计和草稿功能；不会出售、出租或提供给第三方广告用途。

默认情况下，扩展不会向远端传输简历、岗位描述或聊天内容。云端 AI 只有在用户明确配置并启用后才允许使用。匿名遥测默认关闭，并且没有被配置为有效 HTTPS 端点时不会发送任何请求。

完整隐私政策：`docs/PRIVACY_POLICY.md`。

## Upload assets

- Extension package: `dist/resumatch-extension.zip`
- 128px icon: `browser-extension/icons/icon-128.png`
- Small promotional image: `store-assets/promo-440x280.png`
- Screenshot: `store-assets/workbench-empty-screenshot.png` (review before upload; do not upload a screenshot containing real customer data).

## Support

Contact: SUPPORT_EMAIL
