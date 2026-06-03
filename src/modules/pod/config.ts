import { ModuleConfig } from '@cool-midway/core';

/**
 * POD 生成模块
 */
export default () => {
  return {
    name: 'POD生成模块',
    description: 'Temu/POD T恤印花批量生成工作流',
    middlewares: [],
    globalMiddlewares: [],
    order: 0,
    generation: {
      outputDir: '../generated/temu-tshirt',
      provider: 'rightcodes',
      timeoutMs: 180000,
      endpoint: 'https://www.right.codes/draw/v1/images/generations',
      apiKey: process.env.RIGHT_CODES_API_KEY || 'sk-112e8b3dcadb45d79d795502b4dd31d0',
      model: process.env.RIGHT_CODES_IMAGE_MODEL || 'gpt-image-2',
      size: '1024x1024',
      outputSize: '2048x2048',
    },
    prompt: {
      provider: 'deepseek',
      protocol: 'openai-chat',
      endpoint: 'https://api.deepseek.com/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY || 'sk-27de6de884154b28a25db1aae05cbc3a',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      temperature: Number(process.env.POD_PROMPT_TEMPERATURE || 0.7),
      maxTokens: Number(process.env.POD_PROMPT_MAX_TOKENS || 8192),
    },
    cutout: {
      // 抠图依赖本机 ComfyUI 服务；服务不可用时，生图结果仍会先落盘，后续可手动补抠图。
      enabled: true,
      endpoint: process.env.COMFYUI_ENDPOINT || 'http://127.0.0.1:8000',
      model: process.env.COMFYUI_RMBG_MODEL || 'RMBG-2.0',
      timeoutMs: Number(process.env.COMFYUI_TIMEOUT_MS || 180000),
      blackThreshold: Number(process.env.COMFYUI_BLACK_THRESHOLD || 34),
      processRes: Number(process.env.COMFYUI_PROCESS_RES || 1536),
      maskBlur: Number(process.env.COMFYUI_MASK_BLUR || 1),
      subjectMaskOffset: Number(process.env.COMFYUI_SUBJECT_MASK_OFFSET || -1),
    },
  } as ModuleConfig;
};
