/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

interface ImportMetaEnv {
  /** 'false' 时关掉内置 mock，真去请求后端；不设或其它值 = 开 mock */
  readonly VITE_USE_MOCK?: string
  /** 接口前缀，默认 /api */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
