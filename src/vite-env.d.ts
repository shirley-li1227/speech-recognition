/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ZHIPU_API_KEY?: string;
  readonly VITE_ZHIPU_STT_URL?: string;
  readonly VITE_ZHIPU_STT_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
