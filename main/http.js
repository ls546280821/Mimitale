'use strict';

// ============================================================================
//  main/http.js —— 大模型 HTTP 请求：用 Node 自带模块，不依赖任何第三方库
//
//  包含：端点地址的拼接与清洗、通用 JSON 请求、二进制下载、
//  流式对话（SSE 逐块解析），以及把网络/HTTP 错误翻译成人话。
// ============================================================================

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const { DEFAULT_BASE_URL, DEFAULT_MODEL } = require('./providers.js');

function buildHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    // 显式带 User-Agent：部分服务商前面挂了 WAF，对没有 UA 的请求会直接拒绝
    // （返回 403 / 406 之类的网关错误），而不是返回接口本身的错误码。
    'User-Agent': 'Mimitale/1.0 (+https://github.com/ls546280821/Mimitale)'
  };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  return headers;
}

/**
 * 把接口地址末尾多余的端点路径去掉。
 *
 * 用户很容易把完整端点当成「接口地址」填进来（比如直接粘官方文档里的
 * `.../v4/images/generations`），那样再拼一次就变成
 * `.../v4/images/generations/images/generations`，接口直接 404。
 *
 * 只认下面这几个我们自己也拼的端点路径 —— 不做「猜」的匹配，
 * 免得把正常的路径吃掉（比如 `/v4`、`/api` 都原样保留）。
 */
const ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/images/generations',
  '/embeddings',
  '/models'
];

function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');

  // 可能连贴两次，循环剥干净
  for (let guard = 0; guard < 4; guard += 1) {
    const hit = ENDPOINT_SUFFIXES.find((s) => url.toLowerCase().endsWith(s));
    if (!hit) break;
    url = url.slice(0, -hit.length).replace(/\/+$/, '');
  }

  return url;
}

function modelsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

function chatUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

function imagesUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/images/generations`;
}

function embeddingsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/embeddings`;
}

/**
 * 下一个二进制文件（生图接口有时直接给链接）。
 * 和 requestJson 一个路子，只是把响应体当 Buffer 收着，不当 JSON 解析。
 */
function downloadBinary(url, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error('图片链接格式不对。'));
      return;
    }

    const transport = target.protocol === 'http:' ? http : https;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: 'GET'
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadBinary(res.headers.location, timeoutMs).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300 && buffer.length) {
            resolve(buffer);
            return;
          }
          reject(new Error(`下载图片失败（HTTP ${res.statusCode}）。`));
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载图片超时。')));
    req.on('error', (err) => reject(new Error(normalizeNetworkError(err))));
    req.end();
  });
}

/**
 * 一个通用的 JSON 请求（非流式），用于「测试连接」和「拉取模型列表」。
 */
function requestJson({ url, method = 'GET', headers = {}, body = null, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error('接口地址格式不对，请检查「接口地址」这一项。'));
      return;
    }

    const transport = target.protocol === 'http:' ? http : https;
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Length': payload.length } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(text));
            } catch (err) {
              reject(new Error(`接口返回的不是合法 JSON（HTTP ${res.statusCode}）。`));
            }
            return;
          }
          reject(new Error(describeHttpError(res.statusCode, text)));
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时：可能是网络不通，或接口地址写错了。'));
    });
    req.on('error', (err) => {
      reject(new Error(normalizeNetworkError(err)));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function describeHttpError(status, text) {
  // 保留足够长的响应体：网关/WAF 返回的 HTML 错误页往往很长，
  // 截太短就只剩「HTTP 406」这种没信息量的提示，排查不了问题。
  const raw = String(text || '').trim();
  const snippet = raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw;

  if (status === 400) return `400 请求被拒绝：多半是参数不被该服务商接受（比如 max_tokens 超范围、模型名不对）。\n${snippet}`;
  if (status === 401) return `401 未授权：API Key 不对或已失效。\n${snippet}`;
  if (status === 402) return `402 余额不足：账户需要充值。\n${snippet}`;
  if (status === 403) return `403 拒绝访问：Key 没有该模型的权限，或请求被网关拦截。\n${snippet}`;
  if (status === 404) return `404 找不到接口：多半是「接口地址」写错了，应类似 https://api.deepseek.com。\n${snippet}`;
  if (status === 406) {
    return (
      '406 请求不被接受：服务端（或它前面的网关）拒绝了这次请求的格式。\n' +
      '常见原因，按可能性排序：\n' +
      '  1. 「接口地址」写得不完整或多写了路径 —— 应是官方文档给的根地址（例如智谱是 https://open.bigmodel.cn/api/paas/v4）\n' +
      '  2. 公司网络 / 代理 / VPN 在中间改了请求头\n' +
      '  3. 这个 Key 没有开通该模型的权限\n' +
      '下面这段是服务端原样返回的内容，通常能看出是谁拒绝的：\n' +
      snippet
    );
  }
  if (status === 415) return `415 不支持的内容类型：请求体格式被拒绝。\n${snippet}`;
  if (status === 429) return `429 请求太频繁或超出配额，稍后再试。\n${snippet}`;
  if (status >= 500) return `${status} 服务端错误，通常稍后重试即可。\n${snippet}`;
  return `HTTP ${status}\n${snippet}`;
}

function normalizeNetworkError(err) {
  const code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败：检查网络，或接口地址是否写错。';
  if (code === 'ECONNREFUSED') return '连接被拒绝：接口地址或端口不对。';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时：网络不通，或需要代理。';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'HTTPS 证书校验失败：可能有代理在中间拦截。';
  return (err && err.message) || '未知网络错误。';
}

/**
 * 流式对话：SSE 逐块解析，通过 onDelta 回调把增量文本交出去。
 * 返回 { content, reasoning, usage }。
 */
function streamChat({ settings, messages, onDelta, onReasoning, signal }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(chatUrl(settings.baseUrl));
    } catch (err) {
      reject(new Error('接口地址格式不对，请检查「接口地址」这一项。'));
      return;
    }
    if (!settings.apiKey) {
      reject(new Error('还没有填写 API Key，请点左下角「设置」填写。'));
      return;
    }

    const transport = target.protocol === 'http:' ? http : https;

    const body = {
      model: settings.model || DEFAULT_MODEL,
      messages,
      stream: true,
      temperature: Number(settings.temperature),
      max_tokens: Math.max(1, Number(settings.maxTokens) || 2048)
    };
    // 有些服务商不接受 top_p 与 temperature 同时出现，这里仅在显式设置时附带
    if (settings.topP !== undefined && settings.topP !== null && settings.topP !== '') {
      body.top_p = Number(settings.topP);
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          ...buildHeaders(settings),
          'Content-Length': payload.length
        }
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            reject(new Error(describeHttpError(res.statusCode, Buffer.concat(chunks).toString('utf8'))));
          });
          return;
        }

        res.setEncoding('utf8');

        let buffer = '';
        let content = '';
        let reasoning = '';
        let usage = null;
        let finished = false;

        const handleLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) return;
          if (!trimmed.startsWith('data:')) return;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            finished = true;
            return;
          }

          let json;
          try {
            json = JSON.parse(data);
          } catch (err) {
            return; // 忽略半截的心跳/脏数据
          }

          if (json.usage) usage = json.usage;

          const choice = json.choices && json.choices[0];
          if (!choice) return;

          const delta = choice.delta || choice.message || {};
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            if (onReasoning) onReasoning(delta.reasoning_content);
          }
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            if (onDelta) onDelta(delta.content);
          }
        };

        const onAbort = () => {
          req.destroy(new Error('已停止生成。'));
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }

        res.on('data', (chunk) => {
          buffer += chunk;
          // SSE 以空行分隔事件；这里用换行切分即可
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            handleLine(line);
          }
        });

        res.on('end', () => {
          if (buffer) handleLine(buffer);
          if (signal) signal.removeEventListener('abort', onAbort);
          if (!content && !reasoning && !finished) {
            reject(new Error('接口没有返回任何内容。可能是模型名不对，或该模型不支持流式输出。'));
            return;
          }
          resolve({ content, reasoning, usage });
        });

        res.on('error', (err) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(new Error(normalizeNetworkError(err)));
        });
      }
    );

    req.setTimeout(60000, () => {
      req.destroy(new Error('请求超时：60 秒内没有响应。'));
    });
    req.on('error', (err) => {
      if (signal && signal.aborted) {
        reject(new Error('已停止生成。'));
        return;
      }
      reject(new Error(normalizeNetworkError(err)));
    });

    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('已停止生成。'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('已停止生成。')), { once: true });
    }

    req.write(payload);
    req.end();
  });
}

module.exports = {
  buildHeaders,
  modelsUrl,
  chatUrl,
  imagesUrl,
  embeddingsUrl,
  downloadBinary,
  requestJson,
  streamChat
};
