'use strict';

// ============================================================================
//  core/config.js —— 全局常量
// ============================================================================

export const CONFIG = {
  MAX_TURNS: 20,           // 最多带入 API 的对话轮数（settings.maxTurns 的兜底值）
  SAVE_DEBOUNCE_MS: 350,   // 保存防抖延迟
  MAX_INPUT_HEIGHT: 190,   // 输入框最大高度
  SCROLL_BOTTOM_THRESHOLD: 40, // 滚动到底部的判定阈值
  TOAST_DURATION_MS: 3200  // 提示消息显示时长
};
