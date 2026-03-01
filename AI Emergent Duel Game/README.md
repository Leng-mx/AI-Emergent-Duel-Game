# AI Emergent Duel Game

![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Status](https://img.shields.io/badge/status-prototype-1f6feb)
![Architecture](https://img.shields.io/badge/architecture-frontend%20%2B%20backend-0ea5e9)

一个基于大语言模型（LLM）的回合制阵营对抗游戏原型。  
你将作为玩家指挥官，在 10 回合中与敌方阵营进行邀请博弈、聊天室交互、战略推演和终局清算。

---

## 目录

- [项目定位](#项目定位)
- [游戏亮点](#游戏亮点)
- [核心玩法](#核心玩法)
- [计分与胜负机制](#计分与胜负机制)
- [系统架构](#系统架构)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [模型与配置](#模型与配置)
- [API 接口](#api-接口)
- [上下文管理](#上下文管理)
- [页面说明](#页面说明)
- [常见问题](#常见问题)
- [二次开发建议](#二次开发建议)

---

## 项目定位

这是一个“对抗式 LLM 剧情博弈”原型，而不是单点问答 Demo：

- 双方阵营都在动态变化。
- 回合内存在邀请和配对策略。
- 每轮对话会影响积分与多条战局维度。
- 回合结束后由 Director AI 基于全局上下文进行推演。

目标是验证：**多角色、多聊天室、多阶段、多模型决策**在一个前后端一体项目中的完整闭环。

---

## 游戏亮点

### 1) 大模型可自主创建新 NPC

- 敌方 Director 会基于全局态势做增援判断（`spawn_enemy`）。
- 我方 Director 会基于全局态势提出支援建议（`propose_ally`）。
- 我方支援必须由玩家确认后才会加入。

对应模块：

- `backend/strategists.js`
- `backend/npcFactory.js`
- `backend/npcManager.js`

### 2) 四层上下文管理（已实装）

项目已实现统一上下文中心，不再只依赖简单时间线：

- 全局上下文（Global）
- 回合上下文（Round）
- 房间上下文（Room）
- 角色上下文（NPC）

对应模块：

- `backend/context/contextManager.js`

### 3) 回合制对抗与邀请博弈

- 玩家回合开始先手指定邀请目标。
- 其余角色自动发起邀请。
- 同一目标被多人邀请时，目标只接受一方，其他方会被拒绝并重新尝试。
- 邀请阶段结束后进入聊天室阶段。

### 4) 多聊天室并行 + 可窥探

- 每回合按配对创建多个双人聊天室。
- 玩家可查看多个聊天室的实时内容。
- 非玩家聊天室可自动持续对话，直到达到收束条件。
- 每名参与者每房间发言上限 10 次。

### 5) 双 Director 推演机制

- 我方 Director 推演过程每轮可视化。
- 敌方 Director 详细推演在对局结束后统一解锁（战报）。

### 6) 十回合终局清算

- 固定 10 回合，不提前判负。
- 按多维胜点 + 总积分加权结算最终赢家。

---

## 核心玩法

### 回合流程

1. 邀请阶段（`pending_invites`）
2. 聊天室阶段（`active`）
3. 全部聊天室结束后，回合结束（`ended`）
4. Director 推演（`director_done`）
5. 自动进入下一回合（直到第 10 回合清算）

### 邀请机制要点

- 玩家先手可指定邀请对象。
- 每个角色每回合仅参与一次通话配对。
- 同一对角色在连续回合会轮换邀请方，避免固定先手。
- 如果某角色被多人邀请，最终只接受一位邀请者。

### 聊天室机制要点

- 玩家仅能接入本回合分配给自己的聊天室。
- 非玩家聊天室会自动推进对话。
- 每名成员每个房间发言上限默认 10 次。
- 当本回合所有聊天室都结束后，才会推进下一阶段。

---

## 计分与胜负机制

### 每轮动态计分

- 基础分：按互动类型给双方增加基础分。
- 关键词倾向：合作/情报与压制/威胁等词汇影响双方得分。
- 好感变化：NPC 状态变化会进一步影响得分倾向。

### 战局维度（Victory Tracks）

- 战术动量（momentum）
- 情报渗透（intel）
- 阵营协同（command）

### 十轮清算权重

- 战术动量 x3
- 情报渗透 x3
- 阵营协同 x2
- 总积分 x4

按上述权重计算胜点后确定最终赢家。

---

## 系统架构

### 前端

- 纯 HTML/CSS/JS（无前端框架）
- 主要文件：
  - `js/game.js`：游戏流程控制
  - `js/ui.js`：界面渲染与交互
  - `pages/battle.html`：主战斗界面

### 后端

- Node.js 原生 HTTP 服务（ESM）
- 主要文件：
  - `server.js`：路由与核心逻辑
  - `backend/llmClient.js`：模型调用
  - `backend/strategists.js`：敌我 Director 决策
  - `backend/context/contextManager.js`：多层上下文管理

---

## 项目结构

```text
game/
├─ backend/
│  ├─ context/
│  │  └─ contextManager.js
│  ├─ llmClient.js
│  ├─ npcFactory.js
│  ├─ npcManager.js
│  └─ strategists.js
├─ css/
├─ js/
├─ pages/
│  ├─ index.html
│  ├─ battle.html
│  ├─ chatrooms.html
│  ├─ rules.html
│  └─ report.html
├─ server.js
├─ start-local.bat
└─ README.md
```

---

## 快速开始

### 环境要求

- Node.js 18+

### 启动方式

```bash
npm start
```

或 Windows 双击：

```bat
start-local.bat
```

启动后访问：

```text
http://localhost:8787
```

---

## 模型与配置

大厅页需要填写：

- `API Key`（必填）
- `API Base URL`（兼容 OpenAI Chat Completions）
- `Model Name`

默认兼容 OpenAI 风格接口（`/chat/completions`）。

---

## API 接口

### 会话与对局

- `POST /api/session/init`  
  初始化会话

- `GET /api/session/:sessionId`  
  获取会话状态（会推进自动对话）

- `POST /api/session/:sessionId/round/invite`  
  发起本回合邀请（支持 `playerInviteTargetId`）

- `POST /api/session/:sessionId/round/end`  
  手动结束回合（保留接口）

- `POST /api/session/:sessionId/round/next`  
  开始下一回合

### 聊天与连接

- `POST /api/session/:sessionId/connect`  
  玩家接入当前回合目标聊天室

- `POST /api/session/:sessionId/disconnect`  
  玩家断开当前聊天室

- `POST /api/session/:sessionId/player-action`  
  玩家发送一条行动/对话

### Director 与支援

- `POST /api/session/:sessionId/director-step`  
  执行本回合 Director 推演

- `POST /api/session/:sessionId/ally-decision`  
  玩家批准/拒绝我方支援

### 报告与调试

- `GET /api/session/:sessionId/chatrooms`  
  获取聊天室状态与消息（会推进自动对话）

- `GET /api/session/:sessionId/report`  
  获取终局战报

- `GET /api/session/:sessionId/context`  
  获取上下文快照（全局/回合/房间/NPC）

---

## 上下文管理

`backend/context/contextManager.js` 负责统一记录：

- 时间线事件（系统、玩家、NPC、动作、内心）
- 阵营聊天室消息
- 双人聊天室消息
- NPC 状态变化（好感、心态、意图）
- 回合与房间关联关系

并提供：

- 上下文摘要（用于 LLM 提示词）
- 上下文快照（用于调试和排查）
- 上下文统计（用于前端状态观测）

这让“不同 NPC 对话框”不再各自为政，显著降低串上下文问题。

---

## 页面说明

- `pages/index.html`：大厅页（背景介绍、流程介绍、模型配置、玩家角色设定）
- `pages/battle.html`：主战斗页（三栏布局：聊天室导航 / 当前对话 / 战局态势）
- `pages/chatrooms.html`：多聊天室总览页
- `pages/rules.html`：规则页
- `pages/report.html`：战报页

---

## 常见问题

### 1) 为什么直接双击 HTML 打不开完整功能？

该项目依赖后端 API 与会话状态，必须通过本地 Node 服务访问（`http://localhost:8787`），不能用 `file://` 直接打开。

### 2) 为什么某些 NPC 聊天室不继续对话？

新版逻辑下，NPC 房间会自动推进。若你看到旧回合中“已结束”的房间，那是历史状态，需开启新回合观察最新机制。

### 3) 如何排查上下文串线问题？

使用接口：

```text
GET /api/session/:sessionId/context
```

查看 `snapshot.rooms` 与 `snapshot.npcs` 的近期记录是否符合预期。

---

## 二次开发建议

- 将当前 HTTP 轮询改造为 WebSocket 推送，提升聊天室实时性。
- 为上下文管理增加持久化（如 Redis/PostgreSQL），支持断线恢复。
- 增加更细粒度的提示词模板与安全策略（Prompt Guardrails）。
- 增加回放系统（按回合与房间重演）。
- 增加更多胜利维度与可解释分析面板。

---

如果你准备把它作为公开仓库继续演进，建议下一步补充：

- `LICENSE`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `SECURITY.md`

