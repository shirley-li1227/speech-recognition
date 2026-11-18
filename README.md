# Snow的语音笔记

一个基于 `React + TypeScript + Vite` 的中文语音转写应用。  
支持浏览器录音、自动识别、可编辑结果、历史会话管理和移动端自适应。

## 功能特性

- 浏览器录音（麦克风权限请求 + 录音中状态动画）
- 录音停止后自动调用智谱 ASR 接口识别
- 识别结果可编辑、可复制
- 同一会话支持多段录音追加（带时间戳）
- 历史会话保存到 `LocalStorage`（可查看、可删除）
- 录音时长限制（最长 30 秒，自动停止）
- 移动端自适应布局

## 技术栈

- React 18
- TypeScript
- Vite
- Tailwind CSS
- 智谱 AI（GLM-ASR-2512）

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量

API Key 只存在于服务端，不会进入浏览器产物。复制 `.dev.vars.example` 为 `.dev.vars` 并填入 Key：

```bash
cp .dev.vars.example .dev.vars
```

```env
ZHIPU_API_KEY=your_zhipu_api_key
ZHIPU_STT_MODEL=glm-asr-2512
```

切勿使用 `VITE_` 前缀存放密钥，这类变量会被打包进前端 JS，任何访问者都能提取。

### 3) 启动开发服务

`/api/transcribe` 由 Pages Functions 提供，需同时启动两个进程：

```bash
npm run build

# 终端 1：Pages Functions（默认 8788，读取 .dev.vars）
npx wrangler pages dev dist

# 终端 2：前端（vite 已配置 /api 代理到 8788）
npm run dev
```

### 4) 构建生产版本

```bash
npm run build
```

### 5) 本地预览生产包

```bash
npm run preview
```

注意：`vite preview` 只提供静态资源，`/api` 不可用；验证接口请用 `npx wrangler pages dev dist`。

## 使用说明

1. 点击录音按钮开始录音。
2. 再次点击停止录音，系统会自动发起识别。
3. 识别文本会追加到当前会话，并在每段前加时间戳。
4. 可在右侧编辑识别结果，并点击复制按钮复制内容。
5. 左侧可创建新会话、切换历史会话、删除会话。

## 项目结构

```text
speech-recognition/
├─ functions/
│  └─ api/
│     └─ transcribe.ts  # 语音识别代理
├─ src/
│  ├─ App.tsx
│  ├─ main.tsx
│  ├─ index.css
│  └─ vite-env.d.ts
├─ index.html
├─ package.json
├─ .env.example
├─ .dev.vars.example
├─ PRD.md
└─ TECH_DESIGN.md
```

## 常见问题

- 麦克风权限被拒绝
  - 请在浏览器地址栏站点权限中将麦克风设置为允许，然后刷新页面。

- 识别失败或无结果
  - 检查 Cloudflare Pages 的 Secret `ZHIPU_API_KEY` 是否有效（本地开发看 `.dev.vars`）。
  - 检查服务端变量 `ZHIPU_STT_MODEL` 是否为 `glm-asr-2512` 且账号已开通该模型。
  - 返回 401 表示 Key 失效；返回 429 通常是余额不足或未购买 ASR 资源包。

- 历史记录丢失
  - 历史数据存储在浏览器 `LocalStorage`，清理浏览器数据后会丢失。

## 说明

本项目已采用 Cloudflare Pages Functions 服务端代理：前端只调用同源 `/api/transcribe`，`ZHIPU_API_KEY` 以 Secret 形式保存在 Pages 项目中，不会出现在浏览器产物里。

## 部署

Git 推送后由 Cloudflare Pages 自动构建（构建命令 `npm run build`，输出目录 `dist`），`functions/` 目录会被自动识别为 Functions。

手动部署：

```bash
npm run build
npx wrangler pages deploy dist --project-name speech-recognition
```
