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

复制 `.env.example` 为 `.env`，并填写你的智谱 API Key：

```env
VITE_ZHIPU_API_KEY=your_zhipu_api_key
VITE_ZHIPU_STT_URL=https://open.bigmodel.cn/api/paas/v4/audio/transcriptions
VITE_ZHIPU_STT_MODEL=glm-asr-2512
```

### 3) 启动开发服务

```bash
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

## 使用说明

1. 点击录音按钮开始录音。
2. 再次点击停止录音，系统会自动发起识别。
3. 识别文本会追加到当前会话，并在每段前加时间戳。
4. 可在右侧编辑识别结果，并点击复制按钮复制内容。
5. 左侧可创建新会话、切换历史会话、删除会话。

## 项目结构

```text
speech-recognition/
├─ src/
│  ├─ App.tsx
│  ├─ main.tsx
│  ├─ index.css
│  └─ vite-env.d.ts
├─ index.html
├─ package.json
├─ .env.example
├─ PRD.md
└─ TECH_DESIGN.md
```

## 常见问题

- 麦克风权限被拒绝
  - 请在浏览器地址栏站点权限中将麦克风设置为允许，然后刷新页面。

- 识别失败或无结果
  - 检查 `VITE_ZHIPU_API_KEY` 是否有效。
  - 检查 `VITE_ZHIPU_STT_MODEL` 是否为 `glm-asr-2512` 且账号已开通权限。
  - 检查网络与接口地址是否可访问。

- 历史记录丢失
  - 历史数据存储在浏览器 `LocalStorage`，清理浏览器数据后会丢失。

## 说明

本项目为前端直连 API 方案，`VITE_` 前缀变量会暴露到浏览器端。  
如果用于生产环境，建议增加后端代理层来保护密钥并做请求鉴权。
