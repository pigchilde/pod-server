import { Inject, Provide } from '@midwayjs/core';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import { PodSettingService, PodModuleSettings } from './setting';
import { PodComfyService } from './comfy';

export interface PodGenerateImageInput {
  prompt: string;
  fileBaseName: string;
  outputDir: string;
  publicDir: string;
  timeoutMs: number;
  providerImageUrl?: string;
  onProviderImageUrl?: (url: string) => Promise<void>;
  cutoutContext?: PodCutoutContext;
}

export interface PodGenerateImageResult {
  fileName: string;
  filePath: string;
  imageUrl: string;
  providerImageUrl?: string;
  postProcessError?: string;
}

export interface PodCutoutImageInput {
  fileName: string;
  filePath: string;
  imageUrl: string;
  context?: PodCutoutContext;
}

export interface PodCutoutContext {
  batchId?: number;
  batchNo?: string;
  itemId?: number;
  itemNo?: string;
  fileName?: string;
}

/**
 * POD图片生成适配器
 */
@Provide()
export class PodImageService {
  @Inject()
  podSettingService: PodSettingService;

  @Inject()
  podComfyService: PodComfyService;

  async generate(
    input: PodGenerateImageInput
  ): Promise<PodGenerateImageResult> {
    // 每次生成都读取最新模块设置，保存后无需重启服务即可切换模型或接口参数。
    const settings = await this.podSettingService.getSettings();
    if (settings.generation.protocol === 'mock') {
      return this.generateMock(input);
    }
    if (settings.generation.protocol === 'openai-images') {
      return this.generateFromOpenaiImages(input, settings);
    }

    throw new Error(
      `Unsupported POD image provider protocol: ${settings.generation.protocol}`
    );
  }

  async cutout(input: PodCutoutImageInput): Promise<PodGenerateImageResult> {
    // 手动抠图入口：直接对已生成图片做 ComfyUI 背景移除，不再重新调用生图模型。
    const settings = await this.podSettingService.getSettings();
    if (!settings.cutout?.enabled) {
      throw new Error('请先在模块设置中启用 ComfyUI 抠图');
    }

    const sourceBuffer = await fs.promises.readFile(input.filePath);
    const ext =
      path.extname(input.fileName || input.filePath).replace('.', '') || 'png';
    const cutoutBuffer = await this.podComfyService.removeBackground({
      buffer: sourceBuffer,
      fileName: input.fileName || path.basename(input.filePath),
      settings,
      context: input.context,
    });
    const outputBuffer = await this.resizeToOutputSize(
      cutoutBuffer,
      ext,
      settings
    );
    const parsedPath = path.parse(input.filePath);
    const cleanImageUrl = String(input.imageUrl || '').split(/[?#]/)[0];
    const parsedUrl = path.posix.parse(cleanImageUrl);
    const fileName = `${parsedPath.name}.png`;
    const filePath = path.join(parsedPath.dir, fileName);
    const imageUrl = path.posix.join(parsedUrl.dir || '/', fileName);

    await fs.promises.writeFile(filePath, outputBuffer);
    if (filePath !== input.filePath && fs.existsSync(input.filePath)) {
      const backupPath = `${input.filePath}.orig`;
      if (!fs.existsSync(backupPath)) {
        await fs.promises.copyFile(input.filePath, backupPath);
      }
    }

    return {
      fileName,
      filePath,
      imageUrl,
    };
  }

  private async generateFromOpenaiImages(
    input: PodGenerateImageInput,
    settings: PodModuleSettings
  ) {
    // OpenAI images generations 兼容格式调用。
    const generationConfig = settings.generation;
    const endpoint = generationConfig.endpoint;
    if (!endpoint) {
      throw new Error('POD image provider endpoint is not configured');
    }

    let providerImageUrl = String(input.providerImageUrl || '').trim();
    if (!providerImageUrl) {
      const res = await axios.post(
        endpoint,
        {
          model: generationConfig.model || 'gpt-image-2',
          prompt: input.prompt,
          n: 1,
          size: generationConfig.size || '1024x1024',
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
      const b64Json =
        payload?.b64_json || payload?.base64 || payload?.imageBase64;
      if (b64Json) {
        return this.saveBase64(b64Json, input, settings);
      }

      providerImageUrl = payload?.url || payload?.imageUrl;
      if (!providerImageUrl) {
        throw new Error('POD image provider did not return url or b64_json');
      }
      await input.onProviderImageUrl?.(providerImageUrl);
    }

    const image = await axios.get(providerImageUrl, {
      responseType: 'arraybuffer',
      timeout: input.timeoutMs,
    });

    const result = await this.saveBuffer(
      Buffer.from(image.data),
      input,
      this.extensionFromContentType(
        String(image.headers['content-type'] || '')
      ),
      settings
    );
    return {
      ...result,
      providerImageUrl,
    };
  }

  private async saveBase64(
    value: string,
    input: PodGenerateImageInput,
    settings: PodModuleSettings
  ) {
    // 支持纯 base64 和 data:image/png;base64 两种格式。
    const matched = value.match(/^data:image\/(\w+);base64,(.*)$/);
    const ext = matched?.[1] || 'png';
    const data = matched?.[2] || value;
    return this.saveBuffer(Buffer.from(data, 'base64'), input, ext, settings);
  }

  private async generateMock(input: PodGenerateImageInput) {
    // 非 rightcodes provider 用 mock 图兜底，便于本地调试完整流程。
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600" viewBox="0 0 1600 1600">
  <rect width="1600" height="1600" fill="#fff7e8"/>
  <circle cx="800" cy="800" r="560" fill="#171717"/>
  <circle cx="800" cy="800" r="510" fill="#f7c66a"/>
  <text x="800" y="650" text-anchor="middle" font-family="Arial, sans-serif" font-size="96" font-weight="700" fill="#171717">POD MOCK</text>
  <text x="800" y="790" text-anchor="middle" font-family="Arial, sans-serif" font-size="62" font-weight="700" fill="#171717">${this.escapeXml(
    input.fileBaseName
  )}</text>
  <text x="800" y="930" text-anchor="middle" font-family="Arial, sans-serif" font-size="40" fill="#171717">${this.escapeXml(
    input.prompt.slice(0, 80)
  )}</text>
</svg>`;

    return this.saveBuffer(Buffer.from(svg), input, 'svg');
  }

  private async saveBuffer(
    buffer: Buffer,
    input: PodGenerateImageInput,
    ext: string,
    settings?: PodModuleSettings
  ) {
    // 先把图片模型返回的结果落盘；抠图服务异常时，也不能丢掉已经生成好的原图。
    await fs.promises.mkdir(input.outputDir, { recursive: true });
    const fileExt =
      ext === 'svg'
        ? 'svg'
        : settings?.generation?.outputSize || settings?.cutout?.enabled
        ? 'png'
        : ext;
    const fileName = `${input.fileBaseName}.${fileExt}`;
    const filePath = path.join(input.outputDir, fileName);
    const fallbackBuffer = await this.resizeToOutputSize(buffer, ext, settings);
    let outputBuffer = fallbackBuffer;
    let postProcessError = '';

    try {
      // 后处理成功时覆盖为透明 PNG；失败时保留模型原图，避免浪费一次生图结果。
      const cutoutBuffer = await this.removeBackground(
        buffer,
        input,
        ext,
        settings
      );
      outputBuffer = await this.resizeToOutputSize(cutoutBuffer, ext, settings);
    } catch (err) {
      postProcessError = `抠图失败：${err.message}`;
    }

    await this.ensureValidImage(outputBuffer, fileExt);
    await fs.promises.writeFile(filePath, outputBuffer);
    const stat = await fs.promises.stat(filePath);
    if (stat.size <= 1024) {
      throw new Error('Generated image file is too small');
    }

    return {
      fileName,
      filePath,
      imageUrl: path.posix.join(input.publicDir, fileName),
      postProcessError,
    };
  }
  private async removeBackground(
    buffer: Buffer,
    input: PodGenerateImageInput,
    ext: string,
    settings?: PodModuleSettings
  ) {
    if (!settings?.cutout?.enabled || ext === 'svg') {
      return buffer;
    }

    return this.podComfyService.removeBackground({
      buffer,
      fileName: `${input.fileBaseName}.${ext || 'png'}`,
      settings,
      context: input.cutoutContext,
    });
  }

  private async resizeToOutputSize(
    buffer: Buffer,
    ext: string,
    settings?: PodModuleSettings
  ) {
    const outputSize = settings?.generation?.outputSize;
    if (!outputSize || ext === 'svg') {
      return buffer;
    }

    const [width, height] = outputSize.split('x').map(Number);
    if (!width || !height) {
      return buffer;
    }

    // sharp 会保留 PNG alpha 通道；这里强制输出 PNG，确保透明背景不被 JPEG 等格式破坏。
    return sharp(buffer)
      .resize(width, height, {
        fit: 'contain',
        kernel: 'lanczos3',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  }

  private async ensureValidImage(buffer: Buffer, ext: string) {
    const normalized = String(ext || '').toLowerCase();
    if (normalized === 'svg') {
      const head = buffer
        .toString('utf8', 0, Math.min(buffer.length, 200))
        .trim();
      if (!head.includes('<svg')) {
        throw new Error('Generated SVG image is invalid');
      }
      return;
    }

    const signature = buffer.subarray(0, 16);
    const isPng =
      signature.length >= 8 &&
      signature
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg =
      signature.length >= 3 &&
      signature[0] === 0xff &&
      signature[1] === 0xd8 &&
      signature[2] === 0xff;
    const isWebp =
      signature.length >= 12 &&
      signature.toString('ascii', 0, 4) === 'RIFF' &&
      signature.toString('ascii', 8, 12) === 'WEBP';
    const isGif =
      signature.length >= 6 &&
      ['GIF87a', 'GIF89a'].includes(signature.toString('ascii', 0, 6));
    if (!isPng && !isJpeg && !isWebp && !isGif) {
      throw new Error('Generated image file signature is invalid');
    }

    await sharp(buffer).metadata();
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
