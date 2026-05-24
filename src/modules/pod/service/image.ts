import { Inject, Provide } from '@midwayjs/core';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { PodSettingService, PodModuleSettings } from './setting';

export interface PodGenerateImageInput {
  prompt: string;
  seoFileName: string;
  outputDir: string;
  publicDir: string;
  timeoutMs: number;
}

export interface PodGenerateImageResult {
  fileName: string;
  filePath: string;
  imageUrl: string;
}

/**
 * POD图片生成适配器
 */
@Provide()
export class PodImageService {
  @Inject()
  podSettingService: PodSettingService;

  async generate(input: PodGenerateImageInput): Promise<PodGenerateImageResult> {
    // 每次生成都读取最新模块设置，保存后无需重启服务即可切换模型或接口参数。
    const settings = await this.podSettingService.getSettings();
    if (settings.generation.provider === 'rightcodes') {
      return this.generateFromRightCodes(input, settings);
    }

    return this.generateMock(input);
  }

  private async generateFromRightCodes(
    input: PodGenerateImageInput,
    settings: PodModuleSettings
  ) {
    // right.codes 接口按 OpenAI images generations 兼容格式调用。
    const generationConfig = settings.generation;
    const endpoint = generationConfig.endpoint;
    if (!endpoint) {
      throw new Error('POD image provider endpoint is not configured');
    }

    const res = await axios.post(
      endpoint,
      {
        model: generationConfig.model || 'gpt-image-2',
        prompt: input.prompt,
        n: 1,
        size: generationConfig.size || '2048x2048',
      },
      {
        timeout: input.timeoutMs,
        headers: generationConfig.apiKey
          ? { Authorization: `Bearer ${generationConfig.apiKey}` }
          : undefined,
      }
    );

    // 兼容不同中转实现：有的返回 data[0].b64_json，有的直接返回 url/base64。
    const payload = res.data?.data?.[0] || res.data;
    const b64Json = payload?.b64_json || payload?.base64 || payload?.imageBase64;
    if (b64Json) {
      return this.saveBase64(b64Json, input);
    }

    const imageUrl = payload?.url || payload?.imageUrl;
    if (!imageUrl) {
      throw new Error('POD image provider did not return url or b64_json');
    }

    const image = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: input.timeoutMs,
    });

    return this.saveBuffer(
      Buffer.from(image.data),
      input,
      this.extensionFromContentType(String(image.headers['content-type'] || ''))
    );
  }

  private async saveBase64(value: string, input: PodGenerateImageInput) {
    // 支持纯 base64 和 data:image/png;base64 两种格式。
    const matched = value.match(/^data:image\/(\w+);base64,(.*)$/);
    const ext = matched?.[1] || 'png';
    const data = matched?.[2] || value;
    return this.saveBuffer(Buffer.from(data, 'base64'), input, ext);
  }

  private async generateMock(input: PodGenerateImageInput) {
    // 非 rightcodes provider 用 mock 图兜底，便于本地调试完整流程。
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600" viewBox="0 0 1600 1600">
  <rect width="1600" height="1600" fill="#fff7e8"/>
  <circle cx="800" cy="800" r="560" fill="#171717"/>
  <circle cx="800" cy="800" r="510" fill="#f7c66a"/>
  <text x="800" y="650" text-anchor="middle" font-family="Arial, sans-serif" font-size="96" font-weight="700" fill="#171717">POD MOCK</text>
  <text x="800" y="790" text-anchor="middle" font-family="Arial, sans-serif" font-size="62" font-weight="700" fill="#171717">${this.escapeXml(input.seoFileName)}</text>
  <text x="800" y="930" text-anchor="middle" font-family="Arial, sans-serif" font-size="40" fill="#171717">${this.escapeXml(input.prompt.slice(0, 80))}</text>
</svg>`;

    return this.saveBuffer(Buffer.from(svg), input, 'svg');
  }

  private async saveBuffer(
    buffer: Buffer,
    input: PodGenerateImageInput,
    ext: string
  ) {
    // 所有来源最终统一保存到批次目录，并返回前端可访问的静态 URL。
    await fs.promises.mkdir(input.outputDir, { recursive: true });
    const fileName = `${input.seoFileName}.${ext}`;
    const filePath = path.join(input.outputDir, fileName);
    await fs.promises.writeFile(filePath, buffer);
    const stat = await fs.promises.stat(filePath);
    if (stat.size <= 1024) {
      throw new Error('Generated image file is too small');
    }

    return {
      fileName,
      filePath,
      imageUrl: path.posix.join(input.publicDir, fileName),
    };
  }

  private extensionFromContentType(contentType = '') {
    // URL 下载场景下，根据响应类型决定文件后缀；默认按 png 保存。
    if (contentType.includes('jpeg')) {
      return 'jpg';
    }
    if (contentType.includes('webp')) {
      return 'webp';
    }
    if (contentType.includes('gif')) {
      return 'gif';
    }
    return 'png';
  }

  private escapeXml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
