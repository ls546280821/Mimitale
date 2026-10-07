// ---------------------------------------------------------------------------
//  内置目录兜底：服务商模型清单 + 生图尺寸规则
//
//  「服务商没提供模型列表接口时怎么办」这件事的完整实现。拉取模型走的是：
//
//      OpenAI 那套 GET /models
//
//  但不少国内服务商根本没有这个接口（智谱就是），请求会被网关拒掉（常见 406）。
//  本模块的答案是不让用户卡在一个看不懂的错误码上 —— 改把已知模型直接填进表单。
//  往表单里写字的那一步（applyCatalogModels）**不在这里**，留在 views/settings.js：
//  它要用那边的 stashProviderForm() 和入口层注入的 refreshModelSwitch()。
//
//  导出的五个名字就是本模块对外的全部接口：
//   · catalogForBaseUrl / imageCatalogModels  查有哪些内置模型
//   · looksLikeUnsupportedModelList           判断失败原因是不是「这家没有这个接口」
//   · preferImageModel / fillImageSizeOptions 把上面这些铺进设置界面
// ---------------------------------------------------------------------------

import { el } from '../core/dom.js';
import { h, clear } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { providerById } from '../data/providers.js';

// ------------------------------ 模型目录 ------------------------------

/**
 * 各服务商的已知模型目录。
 *
 * 按接口地址里的域名匹配，而不是按服务商名字 —— 名字用户可以随便改。
 *
 * imageModels 是「生图」那一组能用的模型。文本模型不能拿来生图，
 * 选错了接口会报 404 —— 这个坑很容易踩，所以单独列出来。
 */
const MODEL_CATALOG = [
  {
    match: /dashscope\.aliyuncs\.com/i,
    name: '通义千问',
    note: '通义的 OpenAI 兼容模式对部分 Key 不返回模型列表，可先手填',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    imageModels: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wanx-v1']
  },
  {
    match: /moonshot\.cn/i,
    name: 'Kimi',
    note: 'Moonshot 支持模型列表；若拉取失败可从下面挑',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    imageModels: []
  },
  {
    match: /deepseek\.com/i,
    name: 'DeepSeek',
    note: 'DeepSeek 支持模型列表；若拉取失败可从下面挑',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    // DeepSeek 目前没有生图模型
    imageModels: []
  },
  {
    match: /openai\.com/i,
    name: 'OpenAI',
    note: 'OpenAI 支持模型列表；若拉取失败可从下面挑',
    models: ['gpt-4o-mini', 'gpt-4o'],
    imageModels: ['gpt-image-1', 'dall-e-3']
  }
];

export function catalogForBaseUrl(baseUrl) {
  const url = String(baseUrl || '');
  return MODEL_CATALOG.find((c) => c.match.test(url)) || null;
}

/** 某个服务商的内置生图模型（用来并进生图模型下拉） */
export function imageCatalogModels(providerId) {
  const provider = providerById(providerId);
  if (!provider) return [];
  const catalog = catalogForBaseUrl(provider.baseUrl);
  return catalog && Array.isArray(catalog.imageModels) ? catalog.imageModels : [];
}

/** 拉取失败时，判断是不是「这个服务商压根没有模型列表接口」 */
export function looksLikeUnsupportedModelList(message) {
  const text = String(message || '');
  return (
    /\b(406|404|405|501)\b/.test(text) ||
    /不被接受|找不到接口|不支持|Not Acceptable|Method Not Allowed/i.test(text)
  );
}

// ------------------------------ 生图尺寸规则 ------------------------------

/**
 * 各生图模型支持的图片尺寸。
 *
 * 这个必须按模型区分：智谱 glm-image 只认固定的 7 个尺寸（默认 1280x1280），
 * 而本应用早期一律发 1024x1024，于是被接口拒掉（智谱错误码 1210「参数有误」）。
 * 参数来自智谱官方 OpenAPI 的 CreateImageRequest.size 说明。
 */
const IMAGE_SIZE_RULES = [
  {
    match: /^glm-image$/i,
    label: 'GLM-Image',
    sizes: ['1280x1280', '1568x1056', '1056x1568', '1472x1088', '1088x1472', '1728x960', '960x1728'],
    custom: { min: 1024, max: 2048, step: 32 },
    note: '默认 1280x1280。自定义需在 1024-2048 之间、且是 32 的整数倍'
  },
  {
    match: /^cogview/i,
    label: 'CogView',
    sizes: ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'],
    custom: { min: 512, max: 2048, step: 16 },
    note: '默认 1024x1024。自定义需在 512-2048 之间、且是 16 的整数倍'
  }
];

const DEFAULT_IMAGE_SIZES = ['1024x1024', '1024x1792', '1792x1024', '512x512'];

function imageSizeRule(model) {
  const name = String(model || '').trim();
  return IMAGE_SIZE_RULES.find((r) => r.match.test(name)) || null;
}

/** 某个生图模型可选的尺寸列表 */
function sizesForImageModel(model) {
  const rule = imageSizeRule(model);
  return rule ? rule.sizes : DEFAULT_IMAGE_SIZES;
}

/** 尺寸是否合法：已知模型按规则校验，未知模型只做基本格式检查 */
function isValidImageSize(model, size) {
  const value = String(size || '').trim().toLowerCase();
  if (!/^\d{2,4}x\d{2,4}$/.test(value)) return false;

  const rule = imageSizeRule(model);
  if (!rule) return true;

  if (rule.sizes.includes(value)) return true;

  // 不在推荐列表里也可能合法（自定义尺寸），按规则体检
  if (!rule.custom) return false;
  const [w, hgt] = value.split('x').map(Number);
  const { min, max, step } = rule.custom;
  const inRange = (n) => n >= min && n <= max && n % step === 0;
  return inRange(w) && inRange(hgt);
}

// ------------------------------ 铺进设置界面 ------------------------------

/**
 * 生图模型优先选对的。
 *
 * 坑：provider.models 里通常全是文本模型，生图那一组下拉如果直接沿用，
 * 就会把 glm-5.3 这种文本模型发给 /images/generations，接口报 404。
 * 所以有内置生图目录时，主动切过去并说明原因；
 * 用户自己指定了生图模型（模型名看着像生图模型）就不抢。
 */
export function preferImageModel(provider) {
  if (!provider) return;

  const imageModels = imageCatalogModels(provider.id);
  if (!imageModels.length) return;

  const available = Array.isArray(provider.models) ? provider.models.filter(Boolean) : [];
  const current = String(el.s.imageModel.value || '').trim();

  // 当前已经是这家已知的生图模型 —— 不用动
  if (current && imageModels.includes(current)) return;
  // 用户自己在模型列表里放了生图模型并选中了它 —— 尊重用户
  if (current && current !== available[0] && /image|cogview|dall-e|wanx|flux|sd|stable/i.test(current)) return;

  const target = imageModels[0];
  if (target === current) return;

  const option = Array.from(el.s.imageModel.options || []).find((o) => o.value === target);
  if (option) {
    el.s.imageModel.value = target;
  } else {
    el.s.imageModel.appendChild(h('option', { value: target, text: `${target}（内置）` }));
    el.s.imageModel.value = target;
  }

  showToast(
    `这家服务商的生图模型是 ${imageModels.join(' / ')}，` +
      `已从「${current || '文本模型'}」切到「${target}」——` +
      '文本模型不能用来生图，选错会报 404',
    'ok'
  );
}

/**
 * 按当前生图模型重建尺寸下拉，并尽量保留用户原来的选择。
 * 模型不认识时用通用尺寸，不拦着用户。
 */
export function fillImageSizeOptions(model, current) {
  const select = el.s.imageSize;
  if (!select) return;

  const sizes = sizesForImageModel(model);
  const wanted = String(current || '').trim();

  clear(select);
  for (const size of sizes) {
    select.appendChild(h('option', { value: size, text: size }));
  }

  // 已保存的尺寸不在这个模型的列表里：要么直接纠正，要么明确标出来
  if (wanted && !sizes.includes(wanted)) {
    if (isValidImageSize(model, wanted)) {
      // 是合法自定义尺寸，保留
      select.appendChild(h('option', { value: wanted, text: `${wanted}（自定义）` }));
      select.value = wanted;
    } else {
      // 非法（比如 glm-image 配 1024x1024）——直接切到默认值，别让它再撞一次
      const rule = imageSizeRule(model);
      const fallback = sizes[0];
      select.value = fallback;
      if (rule) {
        showToast(
          `${rule.label} 不支持 ${wanted}，已改成 ${fallback}` +
            (rule.note ? `（${rule.note}）` : ''),
          'ok'
        );
      }
    }
    return;
  }

  select.value = wanted && sizes.includes(wanted) ? wanted : sizes[0];
}
