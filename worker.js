// =================================================================================
//  项目: aiemojify-2api (Cloudflare Worker 单文件版)
//  版本: 1.2.0 (代号: Visionary Compatibility - 视觉兼容版)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-28
//
//  [v1.2.0 更新日志]
//  1. [核心功能] 增加对 OpenAI Vision API 格式 (多模态) 的支持。
//     - 现在可以从聊天客户端 (如 Cherry Studio) 直接上传图片进行图生表情。
//  2. [兼容性增强] 新增模型映射功能，可将 gpt-4o 等标准模型ID映射到本服务。
//  3. [代码重构] 增加 Base64 图片上传的辅助函数，优化代码结构。
//  4. [版本迭代] 更新项目版本号及相关注释。
//
//  [v1.1.0 更新日志]
//  1. [UI修复] 修复了参考图上传预览显示不全的问题 (CSS object-fit)。
//  2. [渲染增强] 前端增加 Markdown 解析器，自动将 API 返回的图片链接渲染为画廊。
//  3. [交互优化] 新增实时进度条动画，消除等待焦虑。
//  4. [功能完善] 增加图片一键下载和全屏预览功能。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "aiemojify-2api",
  PROJECT_VERSION: "1.2.0",

  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1",

  // 上游服务配置
  UPSTREAM_ORIGIN: "https://aiemojify.com",
  UPSTREAM_API_URL: "https://aiemojify.com/api",
  
  // 凭证 (请务必保持此 Cookie 有效，否则无法生成)
  UPSTREAM_COOKIE: "language=en; _ga=GA1.1.905901548.1764302059; crisp-client%2Fsession%2Fe9d40bba-2fba-46de-bc0b-a9a50c9c8c0c=session_3f502514-5b32-402e-a6fe-52506d52c479; crisp-client%2Fsocket%2Fe9d40bba-2fba-46de-bc0b-a9a50c9c8c0c=0; _ga_L6P04Y43V2=GS2.1.s1764302059$o1$g1$t1764302081$j38$l0$h0",
  
  // 伪装头
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",

  // 模型列表
  MODELS: [
    "emoji-gen-v1",
    "emoji-style-birthday"
  ],
  DEFAULT_MODEL: "emoji-gen-v1",

  // [新增] 模型映射 (将常见的视觉模型ID映射到此服务支持的模型)
  // 这使得客户端 (如 Cherry Studio) 可以无缝使用，即使它们配置为 gpt-4o
  MODEL_MAPPINGS: {
    "gpt-4o": "emoji-gen-v1",
    "gpt-4-vision-preview": "emoji-gen-v1",
    "dall-e-3": "emoji-gen-v1", // 方便某些客户端通过此模型ID调用
  },

  // 轮询配置
  POLLING_INTERVAL: 1500, // ms
  POLLING_TIMEOUT: 60000, // ms
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    // 环境变量覆盖
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const cookie = env.UPSTREAM_COOKIE || CONFIG.UPSTREAM_COOKIE;
    
    // 将配置注入请求上下文
    request.ctx = { apiKey, cookie };

    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') {
      return handleUI(request);
    } 
    // 3. API 路由
    else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request);
    }
    // 4. 代理上传接口 (用于图生表情)
    else if (url.pathname === '/proxy/upload') {
      return handleProxyUpload(request);
    }
    // 404
    else {
      return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
    }
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request) {
  if (!verifyAuth(request)) {
    return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else if (url.pathname === '/v1/images/generations') {
    return handleImageGenerations(request, requestId);
  } else {
    return createErrorResponse(`不支持的 API 路径: ${url.pathname}`, 404, 'not_found');
  }
}

function verifyAuth(request) {
  const authHeader = request.headers.get('Authorization');
  const validKey = request.ctx.apiKey;
  if (validKey === "1") return true; 
  return authHeader && authHeader === `Bearer ${validKey}`;
}

function handleModelsRequest() {
  // 合并内置模型和映射模型，并去重，让客户端能看到所有可用模型
  const allModelIds = [...new Set([...CONFIG.MODELS, ...Object.keys(CONFIG.MODEL_MAPPINGS)])];

  const modelsData = {
    object: 'list',
    data: allModelIds.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'aiemojify-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

async function performGeneration(prompt, imagePath = null, cookie) {
  const headers = {
    "Content-Type": "application/json",
    "Origin": CONFIG.UPSTREAM_ORIGIN,
    "Referer": `${CONFIG.UPSTREAM_ORIGIN}/birthday-emoji-generator`,
    "User-Agent": CONFIG.USER_AGENT,
    "Cookie": cookie,
    "x-uid": "84.235.235.105"
  };

  const payload = {
    "image_style": "birthday emoji generator",
    "prompts": prompt
  };
  if (imagePath) {
    payload.image_path = imagePath;
  }

  const submitRes = await fetch(`${CONFIG.UPSTREAM_API_URL}/emoji/emoji-image`, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload)
  });

  if (!submitRes.ok) {
    throw new Error(`上游提交失败: ${submitRes.status} ${await submitRes.text()}`);
  }

  const submitData = await submitRes.json();
  if (submitData.status !== 100000 || !submitData.data?.task_id) {
    throw new Error(`任务创建失败: ${JSON.stringify(submitData)}`);
  }

  const taskId = submitData.data.task_id;
  
  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.POLLING_TIMEOUT) {
    const pollUrl = `${CONFIG.UPSTREAM_API_URL}/dash/task-status?task_id=${taskId}&project_name=emoji`;
    const pollRes = await fetch(pollUrl, {
      method: "GET",
      headers: headers
    });

    if (!pollRes.ok) continue;

    const pollData = await pollRes.json();
    
    if (pollData.status === 100000 && pollData.data?.result) {
      return pollData.data.result; 
    }
    
    if (pollData.status === 20008) {
      await new Promise(r => setTimeout(r, CONFIG.POLLING_INTERVAL));
      continue;
    }

    throw new Error(`任务处理失败: ${JSON.stringify(pollData)}`);
  }

  throw new Error("任务轮询超时");
}

/**
 * [新增] 将 Base64 编码的图片数据上传到上游服务
 * @param {string} base64DataUri - "data:image/..." 格式的字符串
 * @param {string} cookie - 用于认证的 cookie
 * @returns {Promise<string>} - 上传成功后返回的图片路径 (image_path)
 */
async function uploadBase64Image(base64DataUri, cookie) {
    const parts = base64DataUri.match(/^data:(image\/.+);base64,(.+)$/);
    if (!parts) throw new Error('无效的 Base64 图片数据 URI');
    
    const mimeType = parts[1];
    const base64 = parts[2];
    const filename = `clipboard-image.${mimeType.split('/')[1] || 'png'}`;

    // atob 在 Cloudflare Workers 环境中是可用的
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });

    const upstreamFormData = new FormData();
    upstreamFormData.append('file', blob, filename);

    const res = await fetch(`${CONFIG.UPSTREAM_API_URL}/dash/upload-image`, {
      method: "POST",
      headers: {
        "User-Agent": CONFIG.USER_AGENT,
        "Origin": CONFIG.UPSTREAM_ORIGIN,
        "Referer": `${CONFIG.UPSTREAM_ORIGIN}/birthday-emoji-generator`,
        "Cookie": cookie
      },
      body: upstreamFormData
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`上游图片上传接口失败: ${res.status} ${errorText}`);
    }

    const data = await res.json();
    if (data.code === 100000 && data.data?.item?.name) {
        return data.data.item.name;
    } else {
        throw new Error(`上游图片上传返回错误: ${JSON.stringify(data)}`);
    }
}


async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    if (!lastMsg) throw new Error("未找到用户消息");

    let prompt = "";
    let imagePath = null;
    const requestedModel = body.model || CONFIG.DEFAULT_MODEL;

    // --- [核心改造] ---
    // 兼容 OpenAI Vision (多模态) API 格式
    if (Array.isArray(lastMsg.content)) {
      const textContent = lastMsg.content.find(item => item.type === 'text');
      const imageContent = lastMsg.content.find(item => item.type === 'image_url');

      prompt = textContent ? textContent.text : "根据这张图片生成一个emoji";

      if (imageContent && imageContent.image_url?.url) {
        const imageUrl = imageContent.image_url.url;
        if (imageUrl.startsWith('data:image')) {
          // 如果是 Base64, 调用新函数上传
          imagePath = await uploadBase64Image(imageUrl, request.ctx.cookie);
        } else {
          // 上游服务不支持直接传 URL, 抛出错误
          throw new Error("暂不支持处理图片 URL，请直接上传图片文件。");
        }
      }
    } 
    // 兼容旧的纯文本或自定义 JSON 格式 (用于 Web UI)
    else if (typeof lastMsg.content === 'string') {
      prompt = lastMsg.content;
      try {
        if (prompt.trim().startsWith('{')) {
          const parsed = JSON.parse(prompt);
          if (parsed.prompt) prompt = parsed.prompt;
          if (parsed.image_path) imagePath = parsed.image_path;
        }
      } catch (e) { /* 解析失败，则视为纯文本 prompt */ }
    } else {
        throw new Error("不支持的消息格式");
    }
    // --- [改造结束] ---

    if (!prompt && !imagePath) throw new Error("Prompt 或图片必须提供至少一个");

    const imageUrls = await performGeneration(prompt, imagePath, request.ctx.cookie);
    
    let markdownContent = `### ✨ 表情包生成成功\n\n`;
    imageUrls.forEach((url, index) => {
      markdownContent += `![Emoji ${index + 1}](${url})\n`;
    });

    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        const chunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [{ index: 0, delta: { content: markdownContent }, finish_reason: null }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        
        const endChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      })();

      return new Response(readable, {
        headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
      });
    } else {
      return new Response(JSON.stringify({
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{
          index: 0,
          message: { role: "assistant", content: markdownContent },
          finish_reason: "stop"
        }]
      }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'generation_failed');
  }
}

async function handleImageGenerations(request, requestId) {
  try {
    const body = await request.json();
    const prompt = body.prompt;
    
    const imageUrls = await performGeneration(prompt, null, request.ctx.cookie);
    
    const data = imageUrls.map(url => ({ url: url }));

    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: data
    }), {
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'generation_failed');
  }
}

async function handleProxyUpload(request) {
  if (!verifyAuth(request)) return createErrorResponse('Unauthorized', 401, 'unauthorized');
  
  try {
    const formData = await request.formData();
    const upstreamFormData = new FormData();
    upstreamFormData.append('file', formData.get('file'));

    const res = await fetch(`${CONFIG.UPSTREAM_API_URL}/dash/upload-image`, {
      method: "POST",
      headers: {
        "User-Agent": CONFIG.USER_AGENT,
        "Origin": CONFIG.UPSTREAM_ORIGIN,
        "Referer": `${CONFIG.UPSTREAM_ORIGIN}/birthday-emoji-generator`,
        "Cookie": request.ctx.cookie
      },
      body: upstreamFormData
    });

    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: corsHeaders({'Content-Type': 'application/json'}) });
  } catch (e) {
    return createErrorResponse(e.message, 500, 'upload_failed');
  }
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { 
        --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; 
        --primary: #FFBF00; --primary-hover: #FFD700; --input-bg: #2A2A2A; 
        --success: #66BB6A; --error: #CF6679;
      }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      
      /* 侧边栏 */
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      
      /* 主区域 */
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      
      /* 通用组件 */
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 10px; border-radius: 4px; cursor: pointer; transition: background 0.2s; }
      .code-block:hover { background: #000; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; font-family: inherit; }
      input:focus, textarea:focus { border-color: var(--primary); outline: none; }
      
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; transition: opacity 0.2s; }
      button:hover { opacity: 0.9; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      /* 聊天/结果窗口 */
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; position: relative; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; border-bottom-right-radius: 2px; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; border-bottom-left-radius: 2px; }
      
      /* 图片画廊 */
      .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 15px; margin-top: 15px; }
      .img-card { position: relative; border-radius: 8px; overflow: hidden; border: 1px solid #333; transition: transform 0.2s; }
      .img-card:hover { transform: scale(1.02); border-color: var(--primary); }
      .img-card img { width: 100%; height: 150px; object-fit: contain; background: #222; display: block; cursor: zoom-in; }
      .download-btn { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); color: #fff; text-align: center; padding: 5px; font-size: 12px; text-decoration: none; opacity: 0; transition: opacity 0.2s; }
      .img-card:hover .download-btn { opacity: 1; }

      /* 上传区域 */
      .upload-area { 
        border: 2px dashed #555; padding: 0; text-align: center; cursor: pointer; border-radius: 6px; margin-bottom: 15px; 
        height: 100px; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;
        transition: border-color 0.2s;
      }
      .upload-area:hover { border-color: var(--primary); background-color: #2a2a2a; }
      .upload-text { font-size: 13px; color: #aaa; pointer-events: none; z-index: 2; }
      .preview-img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; background: #000; opacity: 0.6; z-index: 1; }
      
      /* 进度条 */
      .progress-container { width: 100%; background: #333; height: 6px; border-radius: 3px; margin-top: 10px; overflow: hidden; display: none; }
      .progress-bar { height: 100%; background: var(--primary); width: 0%; transition: width 0.3s ease-out; }
      .status-text { font-size: 12px; color: #888; margin-top: 5px; display: flex; justify-content: space-between; }
      
      /* 动画 */
      @keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }
      .generating { animation: pulse 1.5s infinite; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0; display:flex; align-items:center; gap:10px;">
            🤪 ${CONFIG.PROJECT_NAME} 
            <span style="font-size:12px;color:#888; font-weight:normal; margin-top:4px;">v${CONFIG.PROJECT_VERSION}</span>
        </h2>
        
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型选择</span>
            <select id="model">
                ${[...new Set([...CONFIG.MODELS, ...Object.keys(CONFIG.MODEL_MAPPINGS)])].map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label">参考图 (图生表情 - 可选)</span>
            <input type="file" id="file-input" accept="image/*" style="display:none" onchange="handleFile()">
            <div class="upload-area" id="upload-area" onclick="document.getElementById('file-input').click()">
                <span class="upload-text" id="upload-text">点击或拖拽上传图片</span>
            </div>

            <span class="label">提示词 (Prompt)</span>
            <textarea id="prompt" rows="3" placeholder="描述你想生成的表情，例如: 一只正在写代码的猫..."></textarea>
            
            <button id="btn-gen" onclick="generate()">🚀 开始生成</button>
        </div>
        
        <div style="font-size:12px; color:#666; text-align:center;">
            Powered by Cloudflare Workers & Project Chimera
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:100px;">
                <div style="font-size:40px; margin-bottom:20px;">🎨</div>
                <h3>AI Emojify 代理服务就绪</h3>
                <p>在左侧输入提示词或上传图片，开始创作你的专属表情包。</p>
            </div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        const UPLOAD_URL = "${origin}/proxy/upload";
        let uploadedImagePath = null;
        let progressInterval = null;
        
        function copy(text) {
            navigator.clipboard.writeText(text);
            const el = event.target;
            const originalBg = el.style.background;
            el.style.background = '#333';
            setTimeout(() => el.style.background = originalBg, 200);
        }

        async function handleFile() {
            const input = document.getElementById('file-input');
            const file = input.files[0];
            if (!file) return;

            const area = document.getElementById('upload-area');
            const text = document.getElementById('upload-text');
            
            // 预览 (使用 FileReader)
            const reader = new FileReader();
            reader.onload = (e) => {
                // 清除旧预览
                const oldImg = area.querySelector('.preview-img');
                if(oldImg) oldImg.remove();
                
                const img = document.createElement('img');
                img.src = e.target.result;
                img.className = 'preview-img';
                area.appendChild(img);
                text.style.display = 'none';
            };
            reader.readAsDataURL(file);

            // 上传
            text.style.display = 'block';
            text.innerText = "⏳ 上传中...";
            text.style.color = "#fff";
            text.style.zIndex = "10";
            
            const formData = new FormData();
            formData.append('file', file);

            try {
                const res = await fetch(UPLOAD_URL, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + API_KEY },
                    body: formData
                });
                const data = await res.json();
                if (data.code === 100000 && data.data?.item?.name) {
                    uploadedImagePath = data.data.item.name;
                    text.innerText = "✅ 上传成功";
                    text.style.color = "#66BB6A";
                    text.style.textShadow = "0 1px 2px black";
                } else {
                    text.innerText = "❌ 上传失败";
                    text.style.color = "#CF6679";
                    alert('上传失败');
                }
            } catch (e) {
                text.innerText = "❌ 错误";
                alert('上传错误: ' + e.message);
            }
        }

        function appendMsg(role, html) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerHTML = html;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        // 解析 Markdown 图片链接并生成 HTML
        function parseMarkdownImages(text) {
            const regex = /!\\[.*?\\]\\((.*?)\\)/g;
            let match;
            let imgsHtml = '<div class="gallery">';
            let hasImages = false;
            
            while ((match = regex.exec(text)) !== null) {
                hasImages = true;
                const url = match[1];
                imgsHtml += \`
                    <div class="img-card">
                        <img src="\${url}" onclick="window.open(this.src)">
                        <a href="\${url}" download="emoji.png" class="download-btn" target="_blank">⬇️ 下载</a>
                    </div>
                \`;
            }
            imgsHtml += '</div>';
            return hasImages ? imgsHtml : null;
        }

        async function generate() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt && !uploadedImagePath) return alert('请输入提示词或上传参考图');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerHTML = '⏳ 生成中...';

            // 清空欢迎页
            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            // 显示用户消息
            let userHtml = prompt || '[仅使用参考图]';
            if (uploadedImagePath) userHtml += ' <span style="font-size:12px;color:#888;background:#222;padding:2px 6px;border-radius:4px;">[含参考图]</span>';
            appendMsg('user', userHtml);
            
            // 创建 AI 消息容器 (带进度条)
            const loadingId = 'loading-' + Date.now();
            const loadingMsg = appendMsg('ai', \`
                <div id="\${loadingId}">
                    <div style="margin-bottom:5px;">🤖 正在请求 AI 生成表情...</div>
                    <div class="progress-container" style="display:block">
                        <div class="progress-bar" style="width: 0%"></div>
                    </div>
                    <div class="status-text">
                        <span>处理中</span>
                        <span class="percent">0%</span>
                    </div>
                </div>
            \`);

            // 启动虚假进度条 (因为上游不返回具体进度)
            let progress = 0;
            const progressBar = loadingMsg.querySelector('.progress-bar');
            const percentText = loadingMsg.querySelector('.percent');
            
            progressInterval = setInterval(() => {
                if (progress < 90) {
                    const increment = (95 - progress) * 0.05;
                    progress += increment;
                    if (progress > 95) progress = 95;
                    progressBar.style.width = progress + '%';
                    percentText.innerText = Math.floor(progress) + '%';
                }
            }, 500);

            try {
                // 构造请求体 (使用自定义 JSON 格式)
                let content = JSON.stringify({
                    prompt: prompt,
                    image_path: uploadedImagePath
                });

                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        messages: [{ role: 'user', content: content }],
                        stream: false // 使用非流式，方便一次性处理
                    })
                });

                const data = await res.json();
                
                clearInterval(progressInterval);
                progressBar.style.width = '100%';
                percentText.innerText = '100%';

                if (!res.ok) throw new Error(data.error?.message || '生成失败');

                const md = data.choices[0].message.content;
                const galleryHtml = parseMarkdownImages(md);

                if (galleryHtml) {
                    loadingMsg.innerHTML = \`
                        <div style="color:#66BB6A; font-weight:bold; margin-bottom:10px;">✨ 生成成功!</div>
                        \${galleryHtml}
                    \`;
                } else {
                    loadingMsg.innerHTML = \`<div>\${md}</div>\`; // 如果没有图片，显示原始文本
                }

            } catch (e) {
                clearInterval(progressInterval);
                loadingMsg.innerHTML = \`
                    <div style="color:#CF6679; font-weight:bold;">❌ 生成失败</div>
                    <div style="font-size:12px; margin-top:5px; color:#aaa;">\${e.message}</div>
                \`;
            } finally {
                btn.disabled = false;
                btn.innerHTML = '🚀 开始生成';
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8'
    },
  });
}
