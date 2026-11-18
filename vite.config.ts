import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 本地开发时把 /api 转发到 wrangler pages dev（默认 8788），生产环境由 Pages Functions 直接处理。
    proxy: {
      "/api": "http://127.0.0.1:8788",
    },
  },
});
