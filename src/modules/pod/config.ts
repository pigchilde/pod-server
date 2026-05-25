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
      endpoint: 'https://api.deepseek.com/chat/completions',
      apiKey: process.env.DEEPSEEK_API_KEY || 'sk-27de6de884154b28a25db1aae05cbc3a',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    },
  } as ModuleConfig;
};
